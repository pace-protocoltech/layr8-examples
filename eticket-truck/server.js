const express = require('express');
const { Socket } = require('phoenix-channels');
const { randomUUID } = require('crypto');
const protobuf = require('protobufjs');
const path = require('path');
const fs = require('fs').promises;

const app = express();

// Store connected SSE clients
let clients = [];
const channel = {
  instance: null,
  connected: false,
};

// Phoenix socket configuration
const fromDid = 'did:web:venus.node.layr8.org:truck-1';
const scaleHouse = 'did:web:earth.node.layr8.org:truckit-airticket-1';
const api_key = 'pacedemo_48IcsMKZ_H2v3zrR2QcuLjYgjuzCrlKkI';

// Message types
const PAYLOAD_TYPE = 'http://protocoltech.io/eticketing/material-pickup/1.0';
const CHECK_IN_TYPE =
  'http://protocoltech.io/eticketing/material-pickup/1.0/checkin';
const CONFIRM_TYPE =
  'http://protocoltech.io/eticketing/material-pickup/1.0/checkin-confirmation';
const ETICKET_TYPE =
  'http://protocoltech.io/eticketing/material-pickup/1.0/new-eticket';
const CHECK_OUT_TYPE =
  'http://protocoltech.io/eticketing/material-pickup/1.0/checkout';
const GEO_TYPE =
  'http://protocoltech.io/eticketing/material-pickup/1.0/geo-coordinate';

// Load protobuf definitions
const root = protobuf.loadSync('eticket.proto');
const CheckIn = root.lookupType('CheckIn');
const CheckOut = root.lookupType('CheckOut');
const GeoCoordinates = root.lookupType('GeoCoordinates');

let geoCoords1 = [];
let geoCoords2 = [];
let pos1 = 0;
let pos2 = 0;

async function loadCoordinates() {
  try {
    geoCoords1 = (
      await fs.readFile('./coordinates_attempt1.csv', 'utf8')
    ).split('\n');
    geoCoords2 = (await fs.readFile('./coordinates_sim2.csv', 'utf8')).split(
      '\n'
    );
    console.log('Coordinates loaded successfully');
  } catch (error) {
    console.error('Error loading coordinates:', error);
  }
}

function buildCheckin() {
  const checkinMessage = CheckIn.create({
    truckid: 'DT101',
    jobid: '123456',
    arrivedAt: { seconds: Math.floor(Date.now() / 1000) },
  });

  const buffer = CheckIn.encode(checkinMessage).finish();
  const b64 = Buffer.from(buffer).toString('base64');

  return {
    id: randomUUID(),
    from: fromDid,
    to: scaleHouse,
    type: CHECK_IN_TYPE,
    body: {
      payload: b64,
      response_requested: true,
    },
  };
}

function buildGeo(lat, lon) {
  const messageObj = {
    lat: String(lat),
    long: String(lon),
    measuredAt: { seconds: Math.floor(Date.now() / 1000) },
  };
  const errMsg = GeoCoordinates.verify(messageObj);
  if (errMsg) throw Error(errMsg);

  const geoMessage = GeoCoordinates.create(messageObj);
  const buffer = GeoCoordinates.encode(geoMessage).finish();
  const b64 = Buffer.from(buffer).toString('base64');

  return {
    id: randomUUID(),
    from: fromDid,
    to: scaleHouse,
    type: GEO_TYPE,
    body: {
      payload: b64,
      response_requested: false,
    },
  };
}

function buildCheckout() {
  const checkoutMessage = CheckOut.create({
    truckid: 'DT101',
    jobid: '123456',
    departedAt: { seconds: Math.floor(Date.now() / 1000) },
  });

  const buffer = CheckOut.encode(checkoutMessage).finish();
  const b64 = Buffer.from(buffer).toString('base64');

  return {
    id: randomUUID(),
    from: fromDid,
    to: scaleHouse,
    type: CHECK_OUT_TYPE,
    body: {
      payload: b64,
      response_requested: true,
    },
  };
}

function startGeo1() {
  if (pos1 >= geoCoords1.length) return;

  console.log('Sending Geo', pos1);
  const coordLine = geoCoords1[pos1].trim();
  if (!coordLine) return; // Skip empty lines

  const coords = coordLine.split(',');
  const lat = Number(coords[0]);
  const lon = Number(coords[1]);

  if (isNaN(lat) || isNaN(lon)) {
    console.error('Invalid coordinates:', coords);
    return;
  }

  const message = buildGeo(lat, lon);
  channel.instance.push('message', message);
  broadcastToClients('message', `Sent geo coordinates (1): ${lat}, ${lon}`);

  pos1++;
  if (pos1 < geoCoords1.length) {
    setTimeout(startGeo1, 1000);
  }
}

function startGeo2() {
  console.log('Sending Geo 2', pos2);
  const coords = geoCoords2[pos2].split(',');
  const message = buildGeo(coords[0], coords[1]);
  channel.instance.push('message', message);
  broadcastToClients(
    'message',
    `Sent geo coordinates (2): ${coords[0]}, ${coords[1]}`
  );

  pos2++;
  if (pos2 < geoCoords2.length) {
    setTimeout(startGeo2, 1000);
  }
  if (pos2 >= geoCoords2.length) {
    setTimeout(() => {
      const message = buildCheckout();
      channel.instance.push('message', message);
      broadcastToClients('message', 'Sent checkout request');
    }, 5000);
    return;
  }
}

function sendAcks(channel, messageIds) {
  console.log('\nSending acknowledgements...');
  console.log(messageIds);

  channel.instance
    .push('ack', { ids: messageIds }, 10000)
    .receive('error', (error) =>
      console.log('\nError sending acknowledgements:', error.reason)
    );
}
// Send event to all connected clients
function broadcastToClients(event, data) {
  clients.forEach((client) => {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${data}\n\n`);
  });
}

function initializeSocket() {
  const socket = new Socket('wss://venus.node.layr8.org:4000/plugin_socket', {
    params: { api_key: api_key },
  });

  socket.onOpen(() => {
    broadcastToClients('connected', 'Socket connected');

    const topic = `plugins:${fromDid}`;
    channel.instance = socket.channel(topic, {
      payload_types: [PAYLOAD_TYPE],
    });

    channel.instance
      .join()
      .receive('ok', (resp) => {
        channel.connected = true;
        broadcastToClients('message', 'Channel joined successfully');
      })
      .receive('error', (resp) => {
        channel.connected = false;
        broadcastToClients('message', 'Failed to join channel');
      });

    channel.instance.on('message', (payload) => {
      const message = payload.plaintext;
      broadcastToClients('message', `Received message: ${message.type}`);
      sendAcks(channel, [message.id]);

      if (message.type === CONFIRM_TYPE) {
        // Start sending geo coordinates after check-in confirmation
        setTimeout(startGeo1, 1000);
      } else if (message.type === ETICKET_TYPE) {
        broadcastToClients('eticket', JSON.stringify(message));
        pos2 = 0;
        setTimeout(startGeo2, 1000);
      }
    });
  });

  socket.onClose(() => {
    channel.connected = false;
    broadcastToClients('disconnected', 'Socket closed');
  });

  socket.onError(() => {
    channel.connected = false;
    broadcastToClients('error', 'Socket error occurred');
  });

  socket.connect();
}

// Express routes
app.use(express.static('public'));

// SSE endpoint for real-time updates
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const client = {
    id: Date.now(),
    res,
  };

  clients.push(client);

  req.on('close', () => {
    clients = clients.filter((c) => c.id !== client.id);
  });
});

// Endpoint to start check-in
app.post('/checkin', (req, res) => {
  if (!channel.connected) {
    return res.status(503).json({ error: 'Channel not connected' });
  }

  const message = buildCheckin();
  channel.instance.push('message', message);
  broadcastToClients('message', 'Sent check-in request');
  res.json({ status: 'Check-in initiated' });
});

// Start the server and initialize socket
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  await loadCoordinates();
  initializeSocket();
});
