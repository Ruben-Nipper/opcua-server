// login.js
module.exports = function (RED) {
  const http = require("http");
  const https = require("https");
  const { URL } = require("url");

  function httpGetJson(urlStr) {
    return new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.get(u, res => {
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

  function setCtx(node, key, val, store) {
    const ctx = store === "flow" ? node.context().flow : node.context().global;
    ctx.set(key, val);
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

    async function loginOnce() {
      try {
        const url = buildUrl(node, node.credentials);
        node.status({ fill: "blue", shape: "dot", text: "logging in" });
        const { status, body } = await httpGetJson(url);
        const msg = { payload: null, statusCode: status, url };

        if (status === 200 && body && typeof body === "object") {
          const retcode = body.retcode;
          if (retcode === 0 && body.payload && body.payload.sessiontoken) {
            const token = body.payload.sessiontoken;
            setCtx(node, "Auth.SessionToken", token, node.store);
            setCtx(node, "Auth.Retcode", retcode, node.store);
            msg.payload = { retcode, token, url };
            node.status({ fill: "green", shape: "dot", text: "token ok" });
            node.send(msg);
            return;
          }
          setCtx(node, "Auth.SessionToken", null, node.store);
          setCtx(node, "Auth.Retcode", retcode, node.store);
          msg.payload = { retcode, token: null, url };
          node.status({ fill: "yellow", shape: "ring", text: "retcode " + retcode });
          node.send(msg);
          return;
        }

        setCtx(node, "Auth.SessionToken", null, node.store);
        setCtx(node, "Auth.Retcode", null, node.store);
        msg.payload = { retcode: null, token: null, url };
        msg.error = "http " + status;
        node.status({ fill: "red", shape: "dot", text: "http " + status });
        node.send(msg);
      } catch (err) {
        setCtx(node, "Auth.SessionToken", null, node.store);
        setCtx(node, "Auth.Retcode", null, node.store);
        node.status({ fill: "red", shape: "dot", text: "error" });
        node.error(err);
        node.send({ payload: { retcode: null, token: null, url: null }, statusCode: 0, error: String(err) });
      }
    }

    function startPoll() {
      if (timer || node.pollSeconds <= 0) return;
      timer = setInterval(() => {
        if (!stopping) loginOnce();
      }, node.pollSeconds * 1000);
    }

    function stopPoll() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    node.status({ fill: "grey", shape: "ring", text: "idle" });

    node.on("input", function (msg, send, done) {
      loginOnce().then(() => done && done()).catch(e => done && done(e));
    });

    startPoll();

    node.on("close", function (removed, done) {
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
