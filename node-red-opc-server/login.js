// login.js
module.exports = function (RED) {
  const http = require("http");
  const https = require("https");
  const { URL } = require("url");

  // Nood-TTL als server geen eindtijd / ttl teruggeeft (in seconden)
  const DEFAULT_TTL_SECONDS = 30 * 60; // 30 min
  // Veiligheidsmarge voordat we vernieuwen (in seconden)
  const SKEW_SECONDS = 60;

  function httpGetJson(urlStr, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(urlStr); } catch (e) { reject(new Error("invalid URL")); return; }
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.get({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        timeout: timeoutMs,
        rejectUnauthorized: false
      }, res => {
        const status = res.statusCode || 0;
        const chunks = [];
        res.on("data", d => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let body = null;
          try { body = JSON.parse(buf.toString("utf8")); } catch (e) {}
          resolve({ status, body });
        });
      });
      req.on("timeout", () => req.destroy(new Error("request timeout")));
      req.on("error", reject);
      req.end();
    });
  }

  function buildUrl(cfg, cred) {
    const u = encodeURIComponent(cred.username || "");
    const p = encodeURIComponent(cred.password || "");
    const base = `${cfg.proto}://${cfg.host}:${cfg.port}${cfg.path}`;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}username=${u}&pwd=${p}`;
  }

  function getCtx(node, store) {
    return store === "flow" ? node.context().flow : node.context().global;
  }

  function isExpired(expiresAtMillis) {
    if (!expiresAtMillis || !Number.isFinite(expiresAtMillis)) return true;
    const now = Date.now();
    // vernieuwing iets vóór echte verval (skew)
    return now >= (expiresAtMillis - SKEW_SECONDS * 1000);
  }

  function extractExpiry(body) {
    // Probeer verschillende veelvoorkomende velden
    // 1) ISO datetime string
    const pl = body && body.payload ? body.payload : {};
    const iso = pl.expiresAt || pl.expireAt || pl.validUntil || null;
    if (iso && typeof iso === "string") {
      const t = Date.parse(iso);
      if (Number.isFinite(t)) return t;
    }
    // 2) TTL in seconden
    const ttl = pl.ttl || pl.expiresIn || null;
    if (ttl && Number.isFinite(Number(ttl))) {
      return Date.now() + Number(ttl) * 1000;
    }
    // 3) niets? gebruik default
    return Date.now() + DEFAULT_TTL_SECONDS * 1000;
  }

  function LoginNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.proto = config.proto || "http";
    node.host = config.host || "localhost";
    node.port = parseInt(config.port || 8081, 10);
    node.path = config.path || "/wms/monitor/session/login";
    node.pollSeconds = parseInt(config.pollSeconds || 0, 10) || 0;
    node.store = config.store === "flow" ? "flow" : "global";
    node.credentials = node.credentials || {};

    let timer = null;
    let stopping = false;

    const ctx = getCtx(node, node.store);
    const KEY_TOKEN     = "Auth.SessionToken";
    const KEY_RETCODE   = "Auth.Retcode";
    const KEY_EXPIRESAT = "Auth.ExpiresAt"; // epoch ms

    function getSavedToken() {
      const token = ctx.get(KEY_TOKEN);
      const expiresAt = ctx.get(KEY_EXPIRESAT);
      return { token, expiresAt };
    }

    function saveToken(token, retcode, expiresAtMillis) {
      ctx.set(KEY_TOKEN, token || null);
      ctx.set(KEY_RETCODE, retcode == null ? null : retcode);
      ctx.set(KEY_EXPIRESAT, expiresAtMillis || null);
    }

    function clearToken() {
      saveToken(null, null, null);
    }

    async function doLogin() {
      const url = buildUrl(node, node.credentials);
      node.status({ fill: "blue", shape: "dot", text: "logging in" });
      const { status, body } = await httpGetJson(url);

      if (status !== 200 || !body || typeof body !== "object") {
        clearToken();
        node.status({ fill: "red", shape: "dot", text: "http " + status });
        return { ok: false, status, body: body || null, message: "http " + status };
      }

      const retcode = body.retcode;
      if (retcode === 0 && body.payload && body.payload.sessiontoken) {
        const token = body.payload.sessiontoken;
        const expiresAt = extractExpiry(body);
        saveToken(token, retcode, expiresAt);
        node.status({ fill: "green", shape: "dot", text: "token ok" });
        return { ok: true, status, token, expiresAt, body };
      }

      // retcode != 0
      saveToken(null, retcode, null);
      node.status({ fill: "yellow", shape: "ring", text: "retcode " + retcode });
      return { ok: false, status, body, message: "retcode " + retcode };
    }

    async function ensureToken({ force = false } = {}) {
      const saved = getSavedToken();
      if (!force && saved.token && !isExpired(saved.expiresAt)) {
        // nog geldig → niets doen
        return { reused: true, token: saved.token, expiresAt: saved.expiresAt };
      }
      // geen token of verlopen → inloggen
      return await doLogin();
    }

    function startPoll() {
      if (timer || node.pollSeconds <= 0) return;
      timer = setInterval(async () => {
        if (stopping) return;
        try {
          const st = await ensureToken({ force: false });
          if (st.reused) {
            node.status({ fill: "green", shape: "ring", text: "token valid" });
          }
        } catch (e) {
          node.status({ fill: "red", shape: "dot", text: "login error" });
          node.error(e);
        }
      }, node.pollSeconds * 1000);
    }

    function stopPoll() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    node.status({ fill: "grey", shape: "ring", text: "idle" });

    node.on("input", async function (msg, send, done) {
      try {
        const action = typeof msg.action === "string" ? msg.action.toLowerCase() : "";

        if (action === "logout") {
          clearToken();
          node.status({ fill: "grey", shape: "ring", text: "logged out" });
          send && send({ payload: "logged out" });
          done && done();
          return;
        }

        const force = (action === "force");
        const st = await ensureToken({ force });

        if (st.ok) {
          send && send({
            payload: {
              retcode: 0,
              token: st.token,
              expiresAt: st.expiresAt
            },
            statusCode: 200
          });
        } else if (st.reused) {
          send && send({
            payload: {
              reused: true,
              token: st.token,
              expiresAt: st.expiresAt
            },
            statusCode: 200
          });
        } else {
          send && send({
            payload: {
              retcode: (st.body && st.body.retcode) ?? null,
              error: st.message || "login failed",
              body: st.body || null
            },
            statusCode: st.status || 0
          });
        }
        done && done();
      } catch (err) {
        node.status({ fill: "red", shape: "dot", text: "error" });
        node.error(err);
        send && send({ payload: { error: String(err) }, statusCode: 0 });
        done && done(err);
      }
    });

    // start: probeer 1x geldigheid te checken, login alleen indien nodig
    ensureToken({ force: false }).catch(e => {
      node.status({ fill: "red", shape: "dot", text: "start error" });
      node.error(e);
    });

    startPoll();

    node.on("close", function (_removed, done) {
      stopping = true;
      stopPoll();
      done();
    });
  }

  RED.nodes.registerType("login", LoginNode, {
    credentials: {
      username: { type: "text" },
      password: { type: "password" }
    }
  });
};
