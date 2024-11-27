const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const { Socket } = require('phoenix-channels');
const { randomUUID } = require('crypto');

// Configuration state
let config = {
  host: null,
  myDid: null,
  apiKey: null,
  scheme: 'wss',
  port: '4000',
};

// Protocols supported
const BASIC_MESSAGE = 'https://didcomm.org/basicmessage/2.0';
const TRUST_PING = 'https://didcomm.org/trust-ping/2.0';

// Store message ID to return address mapping
const messageAddressMap = new Map();

// Store Layr8 channel reference
let layr8Channel = null;

// Connect to Layr8 server
function connectToLayr8(config) {
  if (!config.host || !config.myDid || !config.apiKey) {
    console.log('Missing required configuration');
    return null;
  }

  const url = `${config.scheme}://${config.host}:${config.port}/plugin_socket`;
  const socket = new Socket(url, {
    timeout: 1000,
    params: { api_key: config.apiKey },
  });

  socket.onOpen(() => console.log('Connected to Layr8 server'));
  socket.onClose(() => console.log('Disconnected from Layr8 server'));
  socket.onError((error) => console.log('Socket error:', error));
  socket.connect();

  const topic = `plugins:${config.myDid}`;
  const channel = socket.channel(topic, {
    payload_types: [BASIC_MESSAGE, TRUST_PING],
  });

  return new Promise((resolve, reject) => {
    channel
      .join(1000)
      .receive('ok', () => {
        console.log('Joined Layr8 channel');

        // Set up channel message handler
        channel.on('message', (message) => {
          console.log(JSON.stringify(message.context, null, 4));

          if (message.plaintext.type === `${BASIC_MESSAGE}/message`) {
            const {
              from,
              body: { material, weight },
              id,
            } = message.plaintext;

            messageAddressMap.set(id, from);
            console.log(`Stored return address ${from} for message ${id}`);

            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(
                  JSON.stringify({
                    type: 'message',
                    sender:
                      message.context.sender_credentials[0].credentialSubject
                        .label,
                    material: material,
                    weight: weight,
                    id: id,
                  })
                );
              }
            });
          }
        });

        resolve(channel);
      })
      .receive('error', (resp) => {
        console.log('Error joining channel:', resp);
        socket.disconnect();
        reject(new Error(resp.reason || 'Failed to join channel'));
      })
      .receive('timeout', () => {
        console.log('Timeout joining channel');
        socket.disconnect();
        reject(new Error('Connection timeout'));
      });
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/') {
    fs.readFile('index.html', (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('Error loading index.html');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else if (req.url === '/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const newConfig = JSON.parse(body);

        if (!newConfig.host || !newConfig.myDid || !newConfig.apiKey) {
          throw new Error('Missing required configuration fields');
        }

        config = { ...config, ...newConfig };

        if (layr8Channel) {
          layr8Channel.leave();
        }

        try {
          layr8Channel = await connectToLayr8(config);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'success' }));
        } catch (error) {
          console.error('Layr8 connection error:', error);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'error',
              message: error.message,
            })
          );
        }
      } catch (error) {
        console.error('Configuration error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'error',
            message: error.message,
          })
        );
      }
    });
  } else if (req.url === '/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        isConfigured: Boolean(config.host && config.myDid && config.apiKey),
        config: {
          host: config.host,
          myDid: config.myDid,
          apiKey: config.apiKey,
        },
      })
    );
  } else if (req.url.startsWith('/verify/')) {
    if (req.method === 'POST') {
      const messageId = req.url.split('/')[2];
      const returnAddress = messageAddressMap.get(messageId);

      if (!returnAddress) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'error',
            message: 'Message ID not found',
          })
        );
        return;
      }

      const verificationMessage = {
        type: `${BASIC_MESSAGE}/verify`,
        id: randomUUID(),
        from: config.myDid,
        to: [returnAddress],
        body: {
          verifiedMessageId: messageId,
          status: 'verified',
          timestamp: new Date().toISOString(),
        },
      };

      console.log('Sending verification:', verificationMessage);

      layr8Channel
        .push('message', verificationMessage)
        .receive('ok', () => {
          console.log('Verification sent successfully');
          messageAddressMap.delete(messageId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'success' }));
        })
        .receive('error', (resp) => {
          console.log('Verification failed:', resp);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'error',
              message: 'Failed to send verification',
            })
          );
        });
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Web client connected');

  ws.send(
    JSON.stringify({
      type: 'connectionStatus',
      connected: Boolean(layr8Channel),
    })
  );

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    if (data.type === 'chat') {
      if (!layr8Channel) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Not connected to Layr8 server',
          })
        );
        return;
      }

      const messageId = randomUUID();
      const layr8Message = {
        type: `${BASIC_MESSAGE}/message`,
        id: messageId,
        from: config.myDid,
        to: [data.to],
        body: {
          material: data.material,
          weight: data.weight,
        },
      };

      layr8Channel
        .push('message', layr8Message)
        .receive('ok', () => {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'message',
                  sender: config.myDid,
                  material: data.material,
                  weight: data.weight,
                  id: messageId,
                })
              );
            }
          });
        })
        .receive('error', (resp) => {
          console.log('Error sending message:', resp);
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'Failed to send message',
            })
          );
        });
    }
  });

  ws.on('close', () => {
    console.log('Web client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Waiting for configuration...');
});

// Handle process termination
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing server...');
  if (layr8Channel) {
    layr8Channel.leave();
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Closing server...');
  if (layr8Channel) {
    layr8Channel.leave();
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
