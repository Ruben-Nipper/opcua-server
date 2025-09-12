// opcua-server.js
module.exports = function (RED) {
    const opcua = require("node-opcua");

    function OpcUaServerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.name = config.name;
        node.port = parseInt(config.port || 4840, 10);
        node.resourcePath = config.resourcePath || "/UA/MyServer";
        node.hostname = config.hostname || "0.0.0.0";
        node.allowAnonymous = !!config.allowAnonymous;

        // variabelen uit de editor, string of array
        let rawVars = config.variables;
        try {
            if (typeof rawVars === "string" && rawVars.trim().length) {
                rawVars = JSON.parse(rawVars);
            }
        } catch (e) {
            rawVars = [];
        }
        node.variables = Array.isArray(rawVars) ? rawVars : [];

        let server = null;
        let addressSpace = null;
        let namespace = null;

        const nodeMap = new Map();                // topic naar info
        const gctx = node.context().global;

        function toOpcuaType(name) {
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
            return m[name] || opcua.DataType.Int32;
        }

        function defaultFor(dtype) {
            if (dtype === "String") return "";
            if (dtype === "Boolean") return false;
            if (dtype === "DateTime") return new Date(0);
            return 0;
        }

        function coerce(dtype, v) {
            try {
                switch (dtype) {
                    case "Boolean":  return !!v;
                    case "SByte":
                    case "Byte":
                    case "Int16":
                    case "UInt16":
                    case "Int32":
                    case "UInt32":   return Number(v);
                    case "Float":
                    case "Double":   return Number(v);
                    case "String":   return String(v);
                    case "DateTime": return v instanceof Date ? v : new Date(v);
                    default:         return v;
                }
            } catch (e) {
                return v;
            }
        }

        async function startServer() {
            if (server) return;

            server = new opcua.OPCUAServer({
                port: node.port,
                resourcePath: node.resourcePath,
                buildInfo: {
                    productName: "NodeRedOPCUAServer",
                    buildNumber: "1",
                    buildDate: new Date()
                },
                allowAnonymous: node.allowAnonymous,
                hostname: node.hostname
            });

            await server.initialize();

            addressSpace = server.engine.addressSpace;
            namespace = addressSpace.getOwnNamespace();

            nodeMap.clear();

            const accRead      = opcua.makeAccessLevelFlag("CurrentRead");
            const accReadWrite = opcua.makeAccessLevelFlag("CurrentRead | CurrentWrite");

            node.variables.forEach((cfg, idx) => {
                const name = cfg.name || ("Var" + idx);
                const topic = cfg.topic || name;
                const dtype = cfg.dataType || "Int32";
                const dtt = toOpcuaType(dtype);
                const writable = (cfg.writable === undefined) ? true : !!cfg.writable;

                let gVal = gctx.get(topic);
                if (gVal === undefined) {
                    gVal = defaultFor(dtype);
                    gctx.set(topic, gVal);
                }

                const nodeId = "ns=1;s=" + name;

                const vNode = namespace.addVariable({
                    organizedBy: addressSpace.rootFolder.objects,
                    browseName: name,
                    nodeId: nodeId,
                    dataType: dtype,
                    minimumSamplingInterval: 200,
                    accessLevel: writable ? accReadWrite : accRead,
                    userAccessLevel: writable ? accReadWrite : accRead,
                    value: {
                        get: function () {
                            let v = gctx.get(topic);
                            if (v === undefined) v = defaultFor(dtype);
                            return new opcua.Variant({ dataType: dtt, value: v });
                        },
                        set: function (variant) {
                            if (!writable) {
                                return opcua.StatusCodes.BadNotWritable;
                            }
                            const val = coerce(dtype, variant.value);
                            gctx.set(topic, val);
                            node.status({ fill: "blue", shape: "dot", text: topic + " = " + String(val) });
                            return opcua.StatusCodes.Good;
                        }
                    }
                });

                nodeMap.set(topic, { vNode, dtype, writable });
            });

            await server.start();
            const ep = server.endpoints[0].endpointDescriptions()[0].endpointUrl;
            node.status({ fill: "green", shape: "dot", text: "draait op " + ep });
            node.send({ payload: "OPC UA server draait op " + ep, endpoint: ep });
        }

        async function stopServer() {
            if (!server) return;
            const s = server;
            server = null;
            node.status({ fill: "red", shape: "ring", text: "stoppen" });
            try {
                await s.shutdown(1000);
            } catch (e) { }
            node.status({ fill: "red", shape: "dot", text: "gestopt" });
        }

        startServer().catch(err => {
            node.error("start fout, " + err.message);
            node.status({ fill: "red", shape: "dot", text: "start fout" });
        });

        node.on("input", async function (msg, send, done) {
            try {
                if (msg && typeof msg.action === "string") {
                    const action = String(msg.action).toLowerCase();
                    if (action === "start") {
                        await startServer();
                        send({ payload: "gestart" });
                        if (done) done();
                        return;
                    }
                    if (action === "stop") {
                        await stopServer();
                        send({ payload: "gestopt" });
                        if (done) done();
                        return;
                    }
                }

                if (!server) {
                    node.status({ fill: "grey", shape: "ring", text: "niet actief" });
                    send({ payload: "server niet actief" });
                    if (done) done();
                    return;
                }

                const topic = msg && msg.topic;
                if (topic == null) {
                    send({ payload: "geen topic" });
                    if (done) done();
                    return;
                }
                if (!nodeMap.has(topic)) {
                    send({ payload: "onbekend topic, " + topic });
                    if (done) done();
                    return;
                }

                const info = nodeMap.get(topic);
                const dtype = info.dtype;
                const val = coerce(dtype, msg.payload);

                // flow writes blijven toegestaan, ook als client write geweigerd is
                gctx.set(topic, val);

                const dtt = toOpcuaType(dtype);
                if (info.vNode && info.vNode.setValueFromSource) {
                    info.vNode.setValueFromSource(new opcua.Variant({ dataType: dtt, value: val }));
                }

                node.status({ fill: "blue", shape: "dot", text: topic + " = " + String(val) });
                send({ payload: "ok", topic, value: val });
                if (done) done();
            } catch (err) {
                node.error(err);
                node.status({ fill: "red", shape: "dot", text: "fout" });
                if (done) done(err);
            }
        });

        node.on("close", function (removed, done) {
            stopServer().then(() => done()).catch(() => done());
        });
    }

    RED.nodes.registerType("opcua-server-Nipper", OpcUaServerNode);
};
