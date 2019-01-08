module.exports = function(RED) {
    'use strict';

    function AmazonEchoDeviceNode(config) {
        RED.nodes.createNode(this, config);
        var deviceNode = this;

        deviceNode.on('input', function(msg) {

          var nodeDeviceId = formatUUID(config.id);

          if ( nodeDeviceId == msg.deviceid ){
            msg.topic = config.topic;
            deviceNode.send(msg);
          }

        });
    }

    // NodeRED registration
    RED.nodes.registerType("amazon-echo-device", AmazonEchoDeviceNode, {
    });

    function AmazonEchoHubNode(config) {

        RED.nodes.createNode(this, config);
        var hubNode = this;

        var port = 80;

        // Start SSPD service
        sspd(hubNode, port, config);

        // Stoppable kill the server on deploy
        const graceMilliseconds = 500;
        var stoppable = require('stoppable');
        var http = require('http');
        var app = require('express')();
        var httpServer = stoppable(http.createServer(app), graceMilliseconds);

        httpServer.on('error', function(error) {
          hubNode.status({fill:"red", shape:"ring", text:"Unable to start on port " + port});
          RED.log.error(error);
          return;
        });

        httpServer.listen(port, function(error) {

            if (error) {
                hubNode.status({fill:"red", shape:"ring", text:"Unable to start on port " + port});
                RED.log.error(error);
                return;
            }

            hubNode.status({fill:"green", shape:"dot", text:"online"});

            // REST API Settings
            api(app, hubNode, config);
        });

        hubNode.on('input', function(msg) {

          if (config.enableinput && "deviceid" in msg.payload && msg.payload.deviceid !== null){
            setDeviceAttributes(msg.payload.deviceid, msg.payload, hubNode.context());
            payloadHandler(hubNode, msg.payload.deviceid);
          }
        });

        hubNode.on('close', function(removed, doneFunction) {
            httpServer.stop(function(){
                if (typeof doneFunction === 'function')
                    doneFunction();
                RED.log.info("Alexa Local Hub closing done...");
            });
            setImmediate(function(){
                httpServer.emit('close');
            });
        });
    }

    // NodeRED registration
    RED.nodes.registerType("amazon-echo-hub", AmazonEchoHubNode, {
    });

    //
    // REST API
    //
    function api(app, hubNode, config) {

      const Mustache = require("mustache");

      var fs = require('fs');
      var bodyParser = require('body-parser');

      app.use(bodyParser.json());

      app.use(function (req, res, next) {
        if (Object.keys(req.body).length > 0)
          RED.log.debug("Request body: " + JSON.stringify(req.body));
        next()
      })

      app.get('/description.xml', function (req, res) {
        var template = fs.readFileSync(__dirname + '/api/hue/templates/description.xml').toString();

        var data = {
          address: req.hostname,
          port: req.connection.localPort,
          huehubid: getHueHubId(config)
        };

        var output = Mustache.render(template, data);

        res.type('application/xml');
        res.send(output);
      });

      app.post('/api', function (req, res) {
        var template = fs.readFileSync(__dirname + '/api/hue/templates/registration.json', 'utf8').toString();

        var data = {
          username: "c6260f982b43a226b5542b967f612ce"
        };

        var output = Mustache.render(template, data);
        output = JSON.parse(output);

        res.json(output);
      });

      app.get('/api/c6260f982b43a226b5542b967f612ce', function (req, res) {
        var template = fs.readFileSync(__dirname + '/api/hue/templates/registration.json', 'utf8').toString();

        var data = {
          username: "c6260f982b43a226b5542b967f612ce"
        };

        var output = Mustache.render(template, data);
        output = JSON.parse(output);

        res.json(output);
      });

      app.get('/api/c6260f982b43a226b5542b967f612ce/lights', function (req, res) {
        var template = fs.readFileSync(__dirname + '/api/hue/templates/lights/all.json', 'utf8').toString();

        var data = [];
        var devices = getDevices();

        for (var key in devices) {
          var attributes = getDeviceAttributes(devices[key].id, hubNode.context());
          data.push(Object.assign({}, attributes, devices[key]));
        }

        var output = Mustache.render(template, data);
        output = JSON.parse(output);
        delete output.last;

        res.json(output);
      });

      app.get('/api/c6260f982b43a226b5542b967f612ce/lights/:id', function (req, res) {
        var template = fs.readFileSync(__dirname + '/api/hue/templates/lights/get-state.json', 'utf8').toString();

        var deviceName = "";

        getDevices().forEach(function(device) {
          if ( req.params.id == device.id )
            deviceName = device.name
        });

        var data = getDeviceAttributes(req.params.id, hubNode.context());
        data.name = deviceName;

        var output = Mustache.render(template, data);
        output = JSON.parse(output);

        res.json(output);
      });

      app.put('/api/c6260f982b43a226b5542b967f612ce/lights/:id/state', function (req, res) {

        setDeviceAttributes(req.params.id, req.body, hubNode.context());

        var template = fs.readFileSync(__dirname + '/api/hue/templates/lights/set-state.json', 'utf8').toString();

        var data = getDeviceAttributes(req.params.id, hubNode.context());

        var output = Mustache.render(template, data);
        output = JSON.parse(output);

        res.json(output);

        payloadHandler(hubNode, req.params.id);
      });

    }

    //
    // SSDP
    //
    function sspd(hubNode, port, config) {

        var ssdp = require("peer-ssdp");
        var peer = ssdp.createPeer();
        peer.on("search", function(headers, address){
            var isValid = headers.ST && headers.MAN == '"ssdp:discover"';
            if (!isValid)
                return;

            var hueHubId = getHueHubId(config.id);

            // The {{networkInterfaceAddress}} will be replaced before
            // sending the SSDP message with the actual IP Address of the corresponding
            // network interface.
            var xmlDescriptionURL = "http://{{networkInterfaceAddress}}:" + port + "/description.xml";

            var responseBaseTemplate = {
              "HOST": "239.255.255.250:1900",
              "CACHE-CONTROL": "max-age=100",
              "EXT": "",
              "LOCATION": xmlDescriptionURL,
              "SERVER": "Linux/3.14.0 UPnP/1.0 IpBridge/1.17.0"
            }

            var responseTemplates = [
              {
                "ST": "upnp:rootdevice",
                "USN": "uuid:" + hueHubId
              },
              {
                "ST": "uuid:" + hueHubId,
                "USN": "uuid:" + hueHubId
              },
              {
                "ST": "urn:schemas-upnp-org:device:basic:1",
                "USN": "uuid:" + hueHubId
              }
            ]

            var responseNum = 1;
            responseTemplates.forEach(function(responseTemplate) {

              var response = Object.assign({}, responseBaseTemplate, responseTemplate);

              setTimeout(function() {
                  peer.reply(response, address);
              }, 1600 + 100 * responseNum);

              responseNum += 1
            });

        });
        peer.start();
    }

    //
    // Helpers
    //
    function getOrDefault(key, defaultValue, context) {

      var value = null;
      var storageValue = context.get(key);

      // Clone value
      if (storageValue !== undefined) {
        value = Object.assign({}, storageValue);
      }

      return valueOrDefault(value, defaultValue);
    }

    function valueOrDefault(value, defaultValue) {

      if (value === undefined || value === null) {
        value = defaultValue;
      }

      return value;
    }

    function formatUUID(id) {

        if (id === null || id === undefined)
            return "";
        return ("" + id).replace(".", "").trim();
    }

    function getHueHubId(config) {

        var uuid = "00112233-4455-6677-8899-";
        uuid += formatUUID(config.id);
        return uuid;
    }

    function getDevices() {

      var devices = [];

      RED.nodes.eachNode(function(node){
        if ( node.type == "amazon-echo-device" ){
          devices.push({id: formatUUID(node.id), name: node.name});
        }
      });

      return devices;
    }

    function getDeviceAttributes(id, context) {

      var defaultAttributes = {
        on: false,
        bri: 254,
        hue: 0,
        sat: 254,
        ct: 199,
        colormode: "ct"
      };

      return getOrDefault(id, defaultAttributes, context);
    }

    function setDeviceAttributes(id, attributes, context) {

      var currentAttributes = getDeviceAttributes(id, context);

      for (var key in currentAttributes) {
        currentAttributes[key] =
            valueOrDefault(attributes[key], currentAttributes[key]);
      }

      // Set correct color mode
      if ( attributes.ct !== undefined ){
        currentAttributes.colormode = "ct";
      }else if ( attributes.hue !== undefined || attributes.sat !== undefined ) {
        currentAttributes.colormode = "hs";
      }

      // Save attributes
      context.set(id, currentAttributes);

      return getOrDefault(id, currentAttributes, context);
    }

    //
    // Handlers
    //
    function payloadHandler(hubNode, deviceId) {

      var msg = getDeviceAttributes(deviceId, hubNode.context());
      msg.payload = msg.on ? "on" : "off";
      msg.deviceid = deviceId;
      msg.topic= "";

      hubNode.send(msg);
    }

}