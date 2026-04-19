import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./server/config.js";
import {
  assertGuildAccess,
  getGuildCommandsSnapshot,
  getGuildConfiguration,
  getGuildMusic,
  getGuildOverview,
  listDashboardGuilds,
  updateAntiNukeConfiguration,
  updateGuildConfiguration
} from "./server/dashboard-data.js";
import { fetchDiscordToken, fetchDiscordUser, fetchUserGuilds } from "./server/discord.js";
import { assertRateLimit } from "./server/rate-limit.js";
import { consumeOauthState, createOauthState, createSession, destroySession, getSession } from "./server/session.js";
import { antiNukePatchSchema, guildPatchSchema } from "./server/validators.js";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile(join(rootDir, ".env"));
loadEnvFile(join(process.cwd(), ".env"));

const distDir = join(process.cwd(), "dist");
const port = Number(process.env.PORT || 3000);
const publicUrl = process.env.DASHBOARD_PUBLIC_URL || process.env.NEXTAUTH_URL || process.env.AUTH_URL || `http://localhost:${port}`;
const callbackPath = "/api/auth/callback/discord";
const callbackUrl = new URL(callbackPath, publicUrl).toString();
const isSecureCookie = publicUrl.startsWith("https://");
const config = getConfig();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8"
};

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function sanitizeCallbackUrl(rawValue) {
  if (!rawValue) return `${publicUrl}/`;

  try {
    const url = new URL(rawValue, publicUrl);
    const publicOrigin = new URL(publicUrl).origin;
    return url.origin === publicOrigin ? url.toString() : `${publicUrl}/`;
  } catch {
    return `${publicUrl}/`;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getSessionOrReject(req, res) {
  const session = getSession(req, config.nextAuthSecret);
  if (!session?.user) {
    json(res, 401, { error: "Unauthorized" });
    return null;
  }
  return session;
}

function formatSessionUser(user) {
  return {
    id: user.id,
    username: user.username || user.global_name || "Discord User",
    avatar: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`
      : "https://cdn.discordapp.com/embed/avatars/0.png"
  };
}

async function handleApi(req, res) {
  const requestUrl = new URL(req.url || "/", publicUrl);
  const { pathname } = requestUrl;

  if (pathname === "/api/auth/signin/discord") {
    const callback = sanitizeCallbackUrl(requestUrl.searchParams.get("callbackUrl"));
    redirect(res, `/api/discord-login?callbackUrl=${encodeURIComponent(callback)}`);
    return true;
  }

  if (pathname === "/api/discord-login") {
    const callback = sanitizeCallbackUrl(requestUrl.searchParams.get("callbackUrl"));
    const state = createOauthState(res, callback, {
      secret: config.nextAuthSecret,
      secure: isSecureCookie
    });

    const authorizeUrl = new URL("https://discord.com/api/oauth2/authorize");
    authorizeUrl.searchParams.set("client_id", config.discordClientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizeUrl.searchParams.set("scope", "identify guilds");
    authorizeUrl.searchParams.set("state", state);
    redirect(res, authorizeUrl.toString());
    return true;
  }

  if (pathname === callbackPath) {
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    const callback = consumeOauthState(req, res, state, {
      secret: config.nextAuthSecret,
      secure: isSecureCookie
    });

    if (!code || !callback) {
      redirect(res, "/login");
      return true;
    }

    try {
      const token = await fetchDiscordToken(code, callbackUrl);
      const [discordUser, guilds] = await Promise.all([
        fetchDiscordUser(token.access_token),
        fetchUserGuilds(token.access_token)
      ]);

      createSession(res, {
        accessToken: token.access_token,
        user: {
          ...formatSessionUser(discordUser),
          guilds: guilds.map((guild) => ({
            id: guild.id,
            name: guild.name,
            icon: guild.icon,
            owner: guild.owner,
            permissions: guild.permissions
          }))
        }
      }, {
        secret: config.nextAuthSecret,
        secure: isSecureCookie
      });

      redirect(res, callback);
    } catch (error) {
      console.error("[dashboard] Discord login failed:", error);
      redirect(res, "/login");
    }

    return true;
  }

  if (pathname === "/api/auth/signout") {
    destroySession(req, res, {
      secret: config.nextAuthSecret,
      secure: isSecureCookie
    });
    redirect(res, sanitizeCallbackUrl(requestUrl.searchParams.get("callbackUrl") || "/login"));
    return true;
  }

  if (pathname === "/api/guilds" && req.method === "GET") {
    const session = getSessionOrReject(req, res);
    if (!session) return true;

    try {
      assertRateLimit(`guilds:${session.user.id}`, 30, 60_000);
      const guilds = await listDashboardGuilds(session);
      json(res, 200, {
        guilds,
        user: {
          id: session.user.id,
          username: session.user.username,
          avatar: session.user.avatar
        }
      });
    } catch (error) {
      json(res, error.statusCode || 500, { error: error.message || "Failed to load guilds." });
    }
    return true;
  }

  const guildMatch = pathname.match(/^\/api\/guilds\/([^/]+)\/(overview|config|commands|music)$/);
  if (guildMatch) {
    const [, guildId, section] = guildMatch;
    const session = getSessionOrReject(req, res);
    if (!session) return true;

    try {
      const limitKey = `${section}:${session.user.id}:${guildId}`;
      const limits = {
        overview: [60, 60_000],
        config: [req.method === "PATCH" ? 20 : 60, 60_000],
        commands: [40, 60_000],
        music: [90, 60_000]
      };
      const [limit, windowMs] = limits[section];
      assertRateLimit(limitKey, limit, windowMs);

      const accessGuild = await assertGuildAccess(session, guildId);
      if (!accessGuild) {
        json(res, 403, { error: "Forbidden" });
        return true;
      }

      if (section === "overview" && req.method === "GET") {
        json(res, 200, await getGuildOverview(guildId));
        return true;
      }

      if (section === "commands" && req.method === "GET") {
        const { guild } = await getGuildConfiguration(guildId);
        json(res, 200, getGuildCommandsSnapshot(guild));
        return true;
      }

      if (section === "config" && req.method === "GET") {
        json(res, 200, await getGuildConfiguration(guildId));
        return true;
      }

      if (section === "music" && req.method === "GET") {
        json(res, 200, await getGuildMusic(guildId));
        return true;
      }

      if (section === "config" && req.method === "PATCH") {
        const body = await readJsonBody(req);
        const guildPatch = guildPatchSchema.safeParse(body.guild ?? {});
        const antiNukePatch = antiNukePatchSchema.safeParse(body.antiNuke ?? {});

        if (!guildPatch.success || !antiNukePatch.success) {
          json(res, 400, { error: "Invalid configuration payload." });
          return true;
        }

        const [updatedGuild, antiNuke] = await Promise.all([
          updateGuildConfiguration(guildId, guildPatch.data),
          updateAntiNukeConfiguration(guildId, antiNukePatch.data)
        ]);

        json(res, 200, { guild: updatedGuild, antiNuke });
        return true;
      }

      json(res, 405, { error: "Method not allowed" });
    } catch (error) {
      json(res, error.statusCode || 500, { error: error.message || "Dashboard API failed." });
    }
    return true;
  }

  return false;
}

function serveFile(req, res) {
  const requestedPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const safePath = requestedPath === "/" ? "/index.html" : requestedPath;
  const filePath = resolve(join(distDir, safePath));
  const fallbackPath = join(distDir, "index.html");

  if (!filePath.startsWith(distDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const finalPath = existsSync(filePath) ? filePath : fallbackPath;
  const ext = extname(finalPath);
  res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream" });
  createReadStream(finalPath).pipe(res);
}

if (!existsSync(join(distDir, "index.html"))) {
  console.error("[dashboard] dist/index.html not found. Run npm run build first.");
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      const handled = await handleApi(req, res);
      if (!handled) {
        json(res, 404, { error: "Not found" });
      }
      return;
    }

    serveFile(req, res);
  } catch (error) {
    console.error("[dashboard] Request failed:", error);
    if (!res.headersSent) {
      json(res, 500, { error: "Internal server error" });
    } else {
      res.end();
    }
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`[dashboard] Port ${port} is already in use, so Zenith cannot start.`);
    console.error(`[dashboard] Find it: Get-NetTCPConnection -LocalPort ${port} | Select-Object OwningProcess`);
    console.error("[dashboard] Stop it: Stop-Process -Id <PID> -Force");
  } else {
    console.error("[dashboard] Server failed to start:", error);
  }

  process.exit(1);
});

server.listen(port, () => {
  console.log(`[dashboard] Zenith UI + API listening on ${publicUrl}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
