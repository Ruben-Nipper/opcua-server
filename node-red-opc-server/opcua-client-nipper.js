// opcua-client-nipper.js
module.exports = function (RED) {
  const opcua = require("node-opcua");

  function toDataType(name) {
    const m = {
      Boolean:  opcua.DataType.Boolean,
      SByte:    opcua.DataType.SByte,
      Byte:     opcua.DataType.Byte,
      Int16:    opcua.DataType.Int16,
      UInt16:   opcua.DataType.UInt16,
      Int32:    opcua.DataType.Int32,
      UInt32:   opcua.DataType.UInt32,
      Float:    opcua.DataType.Float,
      Double:   opcua.DataType.Double,
      String:   opcua.DataType.String,
      DateTime: opcua.DataType.DateTime
    };
    return m[name] ?? null;
  }

  function guessVariant(val) {
    const t = typeof val;
    if (val instanceof Date) {
      return new opcua.Variant({ dataType: opcua.DataType.DateTime, value: val });
    }
    if (t === "boolean") {
      return new opcua.Variant({ dataType: opcua.DataType.Boolean, value: val });
    }
    if (t === "number") {
      return new opcua.Variant({ dataType: opcua.DataType.Double, value: val });
    }
    return new opcua.Variant({ dataType: opcua.DataType.String, value: String(val) });
  }

  function toVariant(val, dtypeName) {
    if (!dtypeName || dtypeName === "Auto") {
      return guessVariant(val);
    }
    const dt = toDataType(dtypeName);
    if (!dt) {
      return guessVariant(val);
    }
    return new opcua.Variant({ dataType: dt, value: val });
  }

  function ClientNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.endpointUrl = config.endpointUrl || "opc.tcp://localhost:4840";
    node.securityMode = config.securityMode || "None";
    node.securityPolicy = config.securityPolicy || "None";
    node.reconnectSeconds = parseInt(config.reconnectSeconds || 5, 10) || 5;
    node.items = Array.isArray(config.items) ? config.items : [];

    const gctx = node.context().global;
    let client = null;
    let session = null;
    let subscription = null;
    const miMap = new Map();
    const byTopic = new Map();
    const byNodeId = new Map();

    node.items.forEach(it => {
      const topic = it.topic || it.nodeId || "";
      if (!topic || !it.nodeId) return;
      const rec = {
        topic,
        nodeId: it.nodeId,
        dataType: it.dataType || "Auto",
        sampling: parseInt(it.sampling || 200, 10)
      };
      byTopic.set(topic, rec);
      byNodeId.set(rec.nodeId, rec.topic);
    });

    let stopping = false;
    let reconnectTimer = null;

    function secMode(s) {
      const m = opcua.MessageSecurityMode;
      return m[s] ?? m.None;
    }
    function secPolicy(p) {
      const pol = opcua.SecurityPolicy;
      return pol[p] ?? pol.None;
    }

    async function connectOnce() {
      if (stopping) return;
      try {
        node.status({ fill: "grey", shape: "ring", text: "verbinden" });

        client = opcua.OPCUAClient.create({
          securityMode: secMode(node.securityMode),
          securityPolicy: secPolicy(node.securityPolicy),
          endpointMustExist: false,
          keepSessionAlive: true,
          connectionStrategy: { maxRetry: 0 }
        });

        await client.connect(node.endpointUrl);
        session = await client.createSession();

        node.status({ fill: "green", shape: "dot", text: "verbonden" });

        subscription = opcua.ClientSubscription.create(session, {
          requestedPublishingInterval: 250,
          requestedLifetimeCount: 100,
          requestedMaxKeepAliveCount: 10,
          maxNotificationsPerPublish: 1000,
          publishingEnabled: true,
          priority: 10
        });

        for (const rec of byTopic.values()) {
          await addMonitor(rec);
        }

        subscription.on("terminated", () => {
          if (!stopping) scheduleReconnect("sub terminated");
        });

      } catch (err) {
        node.status({ fill: "red", shape: "dot", text: "fout verbinden" });
        node.error(err && err.message ? err.message : String(err));
        scheduleReconnect("connect fout");
      }
    }

    async function addMonitor(rec) {
      if (!subscription || !session) return;
      try {
        const mi = await opcua.ClientMonitoredItem.create(
          subscription,
          { nodeId: rec.nodeId, attributeId: opcua.AttributeIds.Value },
          { samplingInterval: rec.sampling, discardOldest: true, queueSize: 5 },
          opcua.TimestampsToReturn.Both
        );
        mi.on("changed", (dataValue) => {
          const v = dataValue.value ? dataValue.value.value : undefined;
          gctx.set(rec.topic, v);
          node.send({ topic: rec.topic, nodeId: rec.nodeId, payload: v, timestamp: new Date() });
          node.status({ fill: "blue", shape: "dot", text: rec.topic + " = " + String(v) });
        });
        miMap.set(rec.topic, mi);
      } catch (e) {
        node.warn("monitor fout " + rec.nodeId + ", " + e.message);
      }
    }

    async function cleanup() {
      try { if (subscription) await subscription.terminate(); } catch(e) {}
      subscription = null;
      miMap.clear();
      try { if (session) await session.close(); } catch(e) {}
      session = null;
      try { if (client) await client.disconnect(); } catch(e) {}
      client = null;
    }

    function scheduleReconnect(reason) {
      if (stopping) return;
      if (reconnectTimer) return;
      node.status({ fill: "yellow", shape: "ring", text: "opnieuw verbinden, " + reason });
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        await cleanup();
        connectOnce();
      }, node.reconnectSeconds * 1000);
    }

    connectOnce();

    node.on("input", async function (msg, send, done) {
      try {
        const action = typeof msg.action === "string" ? msg.action.toLowerCase() : "";

        if (action === "read") {
          const key = msg.topic || null;
          let rec = null;
          if (key && byTopic.has(key)) {
            rec = byTopic.get(key);
          } else if (msg.nodeId && typeof msg.nodeId === "string") {
            const t = byNodeId.get(msg.nodeId) || msg.nodeId;
            rec = { topic: t, nodeId: msg.nodeId, dataType: "Auto" };
          }
          if (!rec || !session) { if (done) done(); return; }
          const dv = await session.read({ nodeId: rec.nodeId, attributeId: opcua.AttributeIds.Value });
          const val = dv.value ? dv.value.value : undefined;
          gctx.set(rec.topic, val);
          send({ topic: rec.topic, nodeId: rec.nodeId, payload: val, timestamp: new Date() });
          if (done) done();
          return;
        }

        const key = msg.topic || null;
        let rec = null;
        if (key && byTopic.has(key)) {
          rec = byTopic.get(key);
        } else if (msg.nodeId && typeof msg.nodeId === "string") {
          const t = byNodeId.get(msg.nodeId) || msg.nodeId;
          rec = { topic: t, nodeId: msg.nodeId, dataType: msg.datatype || "Auto" };
        }
        if (!rec || !session) { if (done) done(); return; }

        const dtypeName = (typeof msg.datatype === "string" && msg.datatype) ? msg.datatype : rec.dataType;
        const variant = toVariant(msg.payload, dtypeName);

        const statusCode = await session.write({
          nodeId: rec.nodeId,
          attributeId: opcua.AttributeIds.Value,
          value: { value: variant }
        });

        send({ topic: rec.topic, nodeId: rec.nodeId, payload: msg.payload, status: statusCode.toString() });
        if (done) done();
      } catch (err) {
        node.error(err);
        if (done) done(err);
      }
    });

    if (client) {
      client.on("backoff", () => node.status({ fill: "yellow", shape: "ring", text: "wachten..." }));
      client.on("connection_lost", () => scheduleReconnect("verbinding weg"));
      client.on("connection_reestablished", () => node.status({ fill: "green", shape: "dot", text: "herverbonden" }));
    }

    node.on("close", function (removed, done) {
      stopping = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      cleanup().then(() => done()).catch(() => done());
    });
  }

  RED.nodes.registerType("opcua-client-nipper", ClientNode);
};
