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

  const send_acks = (channel, ids) => {
    //console.log("\nSending acks...");
    channel
      .push('ack', { ids: ids }, 10000)
      //.receive("ok", () => console.log("Acks sent successfully"))
      .receive('error', (error) =>
        console.log('\nError sending acks:', error.reason)
      );
  };

  const url = `${config.scheme}://${config.host}/plugin_socket`;
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

  // Define the message handler function separately so we can properly remove it
  const messageHandler = (message) => {
    console.log(JSON.stringify(message.context, null, 4));

    if (message.plaintext.type === `${BASIC_MESSAGE}/message`) {
      const { from, body, id } = message.plaintext;

      send_acks(channel, [id]);

      // Parse the ticket content from the body
      let ticketData = null;
      try {
        if (body && body.content) {
          ticketData = JSON.parse(body.content);
        }
      } catch (error) {
        console.error('Error parsing ticket content:', error);
      }

      // Store the return address AND recipients
      // Filter out ourselves from the recipients list to get "other" recipients
      const allRecipients = ticketData?.recipients || [];
      const otherRecipients = allRecipients.filter(
        (did) => did !== config.myDid && did !== from
      );
      const messageInfo = {
        from: from,
        recipients: ticketData?.recipients || [],
        otherRecipients: otherRecipients,
      };

      messageAddressMap.set(id, messageInfo);
      console.log(
        `Stored return address ${from} and ${messageInfo.otherRecipients.length} other recipients for message ${id}`
      );

      // Safely extract sender label with fallback
      let senderLabel = 'Unknown Sender';
      try {
        if (
          message.context &&
          message.context.sender_credentials &&
          message.context.sender_credentials[0] &&
          message.context.sender_credentials[0].credentialSubject &&
          message.context.sender_credentials[0].credentialSubject.label
        ) {
          senderLabel =
            message.context.sender_credentials[0].credentialSubject.label;
        }
      } catch (error) {
        console.error('Error extracting sender label:', error);
      }

      console.log(ticketData);
      // Extract material and net weight
      const material = ticketData?.material || 'Unknown Material';
      const netWeight = ticketData?.weights?.net || 0;

      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(
            JSON.stringify({
              type: 'message',
              sender: senderLabel,
              material: material,
              weight: netWeight,
              otherRecipients: otherRecipients,
              allRecipients: allRecipients,
              id: id,
            })
          );
        }
      });
    }
  };

  return new Promise((resolve, reject) => {
    channel
      .join(1000)
      .receive('ok', () => {
        console.log('Joined Layr8 channel');

        // Remove any existing message handlers before adding new one
        channel.off('message');

        // Now add the message handler
        channel.on('message', messageHandler);

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
          layr8Channel.off('message');
          layr8Channel.leave();
          layr8Channel = null;
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
      const messageInfo = messageAddressMap.get(messageId);

      if (!messageInfo) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'error',
            message: 'Message ID not found',
          })
        );
        return;
      }

      // Use all recipients from the original message
      // This includes everyone who was listed in the recipients field
      let allRecipients = [...messageInfo.recipients];

      // Also include the original sender if not already in the list
      if (!allRecipients.includes(messageInfo.from)) {
        allRecipients.push(messageInfo.from);
      }

      // Remove ourselves from the list
      allRecipients = allRecipients.filter((did) => did !== config.myDid);

      // Remove duplicates
      const uniqueRecipients = [...new Set(allRecipients)];

      console.log(
        `Sending verification to ${uniqueRecipients.length} recipients:`,
        uniqueRecipients
      );

      // Send verification to all recipients
      const verificationPromises = uniqueRecipients.map((recipient) => {
        const verificationMessage = {
          type: `${BASIC_MESSAGE}/verify`,
          id: randomUUID(),
          from: config.myDid,
          to: [recipient],
          body: {
            verifiedMessageId: messageId,
            status: 'verified',
            timestamp: new Date().toISOString(),
          },
        };

        console.log(`Sending verification to ${recipient}`);

        return new Promise((resolve, reject) => {
          layr8Channel
            .push('message', verificationMessage)
            .receive('ok', () => {
              console.log(`Verification sent successfully to ${recipient}`);
              resolve({ recipient, success: true });
            })
            .receive('error', (resp) => {
              console.log(`Verification failed for ${recipient}:`, resp);
              resolve({ recipient, success: false, error: resp });
            });
        });
      });

      // Wait for all verifications to complete
      Promise.all(verificationPromises)
        .then((results) => {
          const successful = results.filter((r) => r.success).length;
          const failed = results.filter((r) => !r.success).length;

          if (successful > 0) {
            messageAddressMap.delete(messageId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                status: 'success',
                details: {
                  successful,
                  failed,
                  recipients: results,
                },
              })
            );
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                status: 'error',
                message: 'All verifications failed',
                details: results,
              })
            );
          }
        })
        .catch((error) => {
          console.error('Error sending verifications:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'error',
              message: 'Failed to send verifications',
              error: error.message,
            })
          );
        });
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
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
