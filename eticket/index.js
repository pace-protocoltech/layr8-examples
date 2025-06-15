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
const verificationStatusMap = new Map();
const recipientMessageIdMap = new Map();

// Store Layr8 channel reference
let layr8Channel = null;

function parseLayr8Error(errorMessage) {
  // Check for protocols_already_bound error
  if (errorMessage.includes('protocols_already_bound')) {
    const didMatch = errorMessage.match(/did:web:[^>]+/);
    const did = didMatch ? didMatch[0] : 'this DID';
    return `Another client is already connected with ${did}. Only one connection per DID is allowed. Please disconnect the other client first.`;
  }

  // Check for authentication errors
  if (
    errorMessage.includes('authentication_failed') ||
    errorMessage.includes('invalid_api_key')
  ) {
    return 'Authentication failed. Please check your API key.';
  }

  // Check for connection errors
  if (
    errorMessage.includes('connection_refused') ||
    errorMessage.includes('timeout')
  ) {
    return 'Unable to connect to the Layr8 server. Please check the host address and try again.';
  }

  // Check for invalid DID
  if (
    errorMessage.includes('invalid_did') ||
    errorMessage.includes('did_not_found')
  ) {
    return 'Invalid DID. Please check that the DID is correctly formatted.';
  }

  // Generic plugin error
  if (errorMessage.includes('e.connect.plugin.failed')) {
    return 'Failed to connect to Layr8. Please check your configuration and try again.';
  }

  // Return original message if no specific case matches
  return errorMessage;
}

// Connect to Layr8 server
function connectToLayr8(config) {
  if (!config.host || !config.myDid || !config.apiKey) {
    console.log('Missing required configuration');
    return null;
  }

  const send_acks = (channel, ids) => {
    channel
      .push('ack', { ids: ids }, 10000)
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

  // Define the message handler function
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
          console.log('Parsed ticket data:', ticketData);
        }
      } catch (error) {
        console.error('Error parsing ticket content:', error);
      }

      // Check if this is a chat message
      if (ticketData && ticketData.type === 'chat') {
        console.log('Received chat message:', ticketData);

        // Send chat message to WebSocket clients
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: 'chatMessage',
                from: from,
                fromLabel: senderLabel,
                message: ticketData.message,
                timestamp: ticketData.timestamp || new Date().toISOString(),
                id: id,
              })
            );
          }
        });

        return; // Don't process as a regular ticket message
      } // Check if this is a chat message
      if (ticketData && ticketData.type === 'chat') {
        console.log('Received chat message:', ticketData);

        // Send chat message to WebSocket clients
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: 'chatMessage',
                from: from,
                fromLabel: senderLabel,
                message: ticketData.message,
                timestamp: ticketData.timestamp || new Date().toISOString(),
                id: id,
              })
            );
          }
        });

        return; // Don't process as a regular ticket message
      }

      // Store the return address AND recipients
      const allRecipients = ticketData?.recipients || [];
      const otherRecipients = allRecipients.filter(
        (did) => did !== config.myDid && did !== from
      );

      const messageInfo = {
        from: from,
        recipients: ticketData?.recipients || [],
        otherRecipients: otherRecipients,
        recipientMessageIds: ticketData?.recipient_message_ids || {},
      };
      messageAddressMap.set(id, messageInfo);

      // Map all recipient message IDs to our message ID
      if (ticketData?.recipient_message_ids) {
        Object.entries(ticketData.recipient_message_ids).forEach(
          ([recipientDid, recipientMsgId]) => {
            recipientMessageIdMap.set(recipientMsgId, {
              ourMessageId: id,
              recipientDid: recipientDid,
            });
            console.log(
              `Mapped recipient message ID ${recipientMsgId} for ${recipientDid} to our message ${id}`
            );
          }
        );
      }

      // Initialize verification status for this message
      verificationStatusMap.set(id, new Map());

      console.log(
        `Stored return address ${from} and ${otherRecipients.length} other recipients for message ${id}`
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
              recipientMessageIds: ticketData?.recipient_message_ids || {},
              id: id,
            })
          );
        }
      });
    } else if (message.plaintext.type === `${BASIC_MESSAGE}/verify`) {
      // Handle incoming verification messages
      const { from, body, id } = message.plaintext;
      const verifiedMessageId = body?.verifiedMessageId;

      send_acks(channel, [id]);

      console.log(
        `Received verification from ${from} for message ${verifiedMessageId}`
      );

      // Check if this verification is for a recipient's message ID
      const recipientInfo = recipientMessageIdMap.get(verifiedMessageId);
      let actualMessageId = verifiedMessageId;

      if (recipientInfo) {
        actualMessageId = recipientInfo.ourMessageId;
        console.log(
          `Verification is for recipient message ${verifiedMessageId}, mapping to our message ${actualMessageId}`
        );
      }

      // Update verification status
      const verificationStatus = verificationStatusMap.get(actualMessageId);
      if (verificationStatus) {
        verificationStatus.set(from, {
          verified: true,
          timestamp: body?.timestamp || new Date().toISOString(),
        });

        // Notify all WebSocket clients of the verification update
        console.log(
          `Broadcasting verification update to ${wss.clients.size} WebSocket clients`
        );
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            const updateMessage = {
              type: 'verificationUpdate',
              messageId: actualMessageId,
              verifier: from,
              timestamp: body?.timestamp,
            };
            console.log('Sending verification update:', updateMessage);
            client.send(JSON.stringify(updateMessage));
          }
        });
      } else {
        console.log(
          `No verification status map found for message ${actualMessageId}`
        );
      }
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

          // Parse the error message to make it user-friendly
          const userFriendlyError = parseLayr8Error(error.message);

          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'error',
              message: userFriendlyError,
              // Include original error for debugging if needed
              technicalDetails: error.message,
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
        // Use the recipient's specific message ID if available
        let messageIdToVerify = messageId; // default to our message ID

        if (
          messageInfo.recipientMessageIds &&
          messageInfo.recipientMessageIds[recipient]
        ) {
          messageIdToVerify = messageInfo.recipientMessageIds[recipient];
          console.log(
            `Using recipient-specific message ID ${messageIdToVerify} for ${recipient}`
          );
        }

        const verificationMessage = {
          type: `${BASIC_MESSAGE}/verify`,
          id: randomUUID(),
          from: config.myDid,
          to: [recipient],
          body: {
            verifiedMessageId: messageIdToVerify,
            status: 'verified',
            timestamp: new Date().toISOString(),
          },
        };

        console.log(
          `Sending verification to ${recipient} for message ${messageIdToVerify}`
        );

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
            // Don't delete the message info yet as we might receive more verifications
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
  } else if (req.url === '/disconnect' && req.method === 'POST') {
    if (layr8Channel) {
      layr8Channel.off('message');
      layr8Channel.leave();
      layr8Channel = null;
    }

    // Clear all stored data
    messageAddressMap.clear();
    verificationStatusMap.clear();
    recipientMessageIdMap.clear();

    // Reset config
    config = {
      host: null,
      myDid: null,
      apiKey: null,
      scheme: 'wss',
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success' }));
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

      // Check if this is a chat message (has message field) or ticket message (has material/weight)
      let messageContent;

      if (data.message) {
        // This is a chat message
        messageContent = {
          type: 'chat',
          message: data.message,
          timestamp: new Date().toISOString(),
          from: config.myDid,
        };
      } else if (data.material && data.weight) {
        // This is a ticket/verification message (keeping existing functionality)
        messageContent = {
          material: data.material,
          weight: data.weight,
          issuer: config.myDid,
          timestamp: new Date().toISOString(),
        };
      }

      const layr8Message = {
        type: `${BASIC_MESSAGE}/message`,
        id: messageId,
        from: config.myDid,
        to: [data.to],
        body: {
          content: JSON.stringify(messageContent),
          locale: 'en',
        },
      };

      console.log(`Sending message to ${data.to}:`, messageContent);

      layr8Channel
        .push('message', layr8Message)
        .receive('ok', () => {
          // Send appropriate response based on message type
          if (data.message) {
            ws.send(
              JSON.stringify({
                type: 'chatSent',
                status: 'success',
                messageId: messageId,
              })
            );
          } else {
            // Keep existing behavior for ticket messages
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
          }
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
const verificationStatusMap = new Map();
const recipientMessageIdMap = new Map();

// Store Layr8 channel reference
let layr8Channel = null;

function parseLayr8Error(errorMessage) {
  // Check for protocols_already_bound error
  if (errorMessage.includes('protocols_already_bound')) {
    const didMatch = errorMessage.match(/did:web:[^>]+/);
    const did = didMatch ? didMatch[0] : 'this DID';
    return `Another client is already connected with ${did}. Only one connection per DID is allowed. Please disconnect the other client first.`;
  }

  // Check for authentication errors
  if (
    errorMessage.includes('authentication_failed') ||
    errorMessage.includes('invalid_api_key')
  ) {
    return 'Authentication failed. Please check your API key.';
  }

  // Check for connection errors
  if (
    errorMessage.includes('connection_refused') ||
    errorMessage.includes('timeout')
  ) {
    return 'Unable to connect to the Layr8 server. Please check the host address and try again.';
  }

  // Check for invalid DID
  if (
    errorMessage.includes('invalid_did') ||
    errorMessage.includes('did_not_found')
  ) {
    return 'Invalid DID. Please check that the DID is correctly formatted.';
  }

  // Generic plugin error
  if (errorMessage.includes('e.connect.plugin.failed')) {
    return 'Failed to connect to Layr8. Please check your configuration and try again.';
  }

  // Return original message if no specific case matches
  return errorMessage;
}

// Connect to Layr8 server
function connectToLayr8(config) {
  if (!config.host || !config.myDid || !config.apiKey) {
    console.log('Missing required configuration');
    return null;
  }

  const send_acks = (channel, ids) => {
    channel
      .push('ack', { ids: ids }, 10000)
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

  // Define the message handler function
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
          console.log('Parsed ticket data:', ticketData);
        }
      } catch (error) {
        console.error('Error parsing ticket content:', error);
      }

      // Check if this is a chat message
      if (ticketData && ticketData.type === 'chat') {
        console.log('Received chat message:', ticketData);

        // Send chat message to WebSocket clients
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: 'chatMessage',
                from: from,
                fromLabel: senderLabel,
                message: ticketData.message,
                timestamp: ticketData.timestamp || new Date().toISOString(),
                id: id,
              })
            );
          }
        });

        return; // Don't process as a regular ticket message
      } // Check if this is a chat message
      if (ticketData && ticketData.type === 'chat') {
        console.log('Received chat message:', ticketData);

        // Send chat message to WebSocket clients
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: 'chatMessage',
                from: from,
                fromLabel: senderLabel,
                message: ticketData.message,
                timestamp: ticketData.timestamp || new Date().toISOString(),
                id: id,
              })
            );
          }
        });

        return; // Don't process as a regular ticket message
      }

      // Store the return address AND recipients
      const allRecipients = ticketData?.recipients || [];
      const otherRecipients = allRecipients.filter(
        (did) => did !== config.myDid && did !== from
      );

      const messageInfo = {
        from: from,
        recipients: ticketData?.recipients || [],
        otherRecipients: otherRecipients,
        recipientMessageIds: ticketData?.recipient_message_ids || {},
      };
      messageAddressMap.set(id, messageInfo);

      // Map all recipient message IDs to our message ID
      if (ticketData?.recipient_message_ids) {
        Object.entries(ticketData.recipient_message_ids).forEach(
          ([recipientDid, recipientMsgId]) => {
            recipientMessageIdMap.set(recipientMsgId, {
              ourMessageId: id,
              recipientDid: recipientDid,
            });
            console.log(
              `Mapped recipient message ID ${recipientMsgId} for ${recipientDid} to our message ${id}`
            );
          }
        );
      }

      // Initialize verification status for this message
      verificationStatusMap.set(id, new Map());

      console.log(
        `Stored return address ${from} and ${otherRecipients.length} other recipients for message ${id}`
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
              recipientMessageIds: ticketData?.recipient_message_ids || {},
              id: id,
            })
          );
        }
      });
    } else if (message.plaintext.type === `${BASIC_MESSAGE}/verify`) {
      // Handle incoming verification messages
      const { from, body, id } = message.plaintext;
      const verifiedMessageId = body?.verifiedMessageId;

      send_acks(channel, [id]);

      console.log(
        `Received verification from ${from} for message ${verifiedMessageId}`
      );

      // Check if this verification is for a recipient's message ID
      const recipientInfo = recipientMessageIdMap.get(verifiedMessageId);
      let actualMessageId = verifiedMessageId;

      if (recipientInfo) {
        actualMessageId = recipientInfo.ourMessageId;
        console.log(
          `Verification is for recipient message ${verifiedMessageId}, mapping to our message ${actualMessageId}`
        );
      }

      // Update verification status
      const verificationStatus = verificationStatusMap.get(actualMessageId);
      if (verificationStatus) {
        verificationStatus.set(from, {
          verified: true,
          timestamp: body?.timestamp || new Date().toISOString(),
        });

        // Notify all WebSocket clients of the verification update
        console.log(
          `Broadcasting verification update to ${wss.clients.size} WebSocket clients`
        );
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            const updateMessage = {
              type: 'verificationUpdate',
              messageId: actualMessageId,
              verifier: from,
              timestamp: body?.timestamp,
            };
            console.log('Sending verification update:', updateMessage);
            client.send(JSON.stringify(updateMessage));
          }
        });
      } else {
        console.log(
          `No verification status map found for message ${actualMessageId}`
        );
      }
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

          // Parse the error message to make it user-friendly
          const userFriendlyError = parseLayr8Error(error.message);

          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'error',
              message: userFriendlyError,
              // Include original error for debugging if needed
              technicalDetails: error.message,
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
        // Use the recipient's specific message ID if available
        let messageIdToVerify = messageId; // default to our message ID

        if (
          messageInfo.recipientMessageIds &&
          messageInfo.recipientMessageIds[recipient]
        ) {
          messageIdToVerify = messageInfo.recipientMessageIds[recipient];
          console.log(
            `Using recipient-specific message ID ${messageIdToVerify} for ${recipient}`
          );
        }

        const verificationMessage = {
          type: `${BASIC_MESSAGE}/verify`,
          id: randomUUID(),
          from: config.myDid,
          to: [recipient],
          body: {
            verifiedMessageId: messageIdToVerify,
            status: 'verified',
            timestamp: new Date().toISOString(),
          },
        };

        console.log(
          `Sending verification to ${recipient} for message ${messageIdToVerify}`
        );

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
            // Don't delete the message info yet as we might receive more verifications
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
  } else if (req.url === '/disconnect' && req.method === 'POST') {
    if (layr8Channel) {
      layr8Channel.off('message');
      layr8Channel.leave();
      layr8Channel = null;
    }

    // Clear all stored data
    messageAddressMap.clear();
    verificationStatusMap.clear();
    recipientMessageIdMap.clear();

    // Reset config
    config = {
      host: null,
      myDid: null,
      apiKey: null,
      scheme: 'wss',
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success' }));
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

      // Check if this is a chat message (has message field) or ticket message (has material/weight)
      let messageContent;

      if (data.message) {
        // This is a chat message
        messageContent = {
          type: 'chat',
          message: data.message,
          timestamp: new Date().toISOString(),
          from: config.myDid,
        };
      } else if (data.material && data.weight) {
        // This is a ticket/verification message (keeping existing functionality)
        messageContent = {
          material: data.material,
          weight: data.weight,
          issuer: config.myDid,
          timestamp: new Date().toISOString(),
        };
      }

      const layr8Message = {
        type: `${BASIC_MESSAGE}/message`,
        id: messageId,
        from: config.myDid,
        to: [data.to],
        body: {
          content: JSON.stringify(messageContent),
          locale: 'en',
        },
      };

      console.log(`Sending message to ${data.to}:`, messageContent);

      layr8Channel
        .push('message', layr8Message)
        .receive('ok', () => {
          // Send appropriate response based on message type
          if (data.message) {
            ws.send(
              JSON.stringify({
                type: 'chatSent',
                status: 'success',
                messageId: messageId,
              })
            );
          } else {
            // Keep existing behavior for ticket messages
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
          }
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
