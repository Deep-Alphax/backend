#!/usr/bin/env node
// Simulates PIX payment confirmation via the backend API (triggers WebSocket event).
// Use only in sandbox/homologação — the endpoint is blocked in production.
//
// Usage:
//   node scripts/simulate-pix-paid.js <transactionId> [apiUrl]
//
// Examples:
//   node scripts/simulate-pix-paid.js fc0ffebe-0822-4cf7-b4be-c5d1aedb4646
//   node scripts/simulate-pix-paid.js fc0ffebe-0822-4cf7-b4be-c5d1aedb4646 http://localhost:3333

const http  = require('http');
const https = require('https');

const transactionId = process.argv[2];
const apiUrl        = process.argv[3] || 'http://localhost:3333';

if (!transactionId) {
  console.error('Usage: node scripts/simulate-pix-paid.js <transactionId> [apiUrl]');
  console.error('Example: node scripts/simulate-pix-paid.js fc0ffebe-0822-4cf7-b4be-c5d1aedb4646');
  process.exit(1);
}

const url      = new URL(`/api/v1/payments/sandbox/simulate-pix-paid/${transactionId}`, apiUrl);
const client   = url.protocol === 'https:' ? https : http;

const options = {
  hostname: url.hostname,
  port: url.port || (url.protocol === 'https:' ? 443 : 80),
  path: url.pathname,
  method: 'GET',
};

console.log(`\nSimulating PIX paid for transactionId: ${transactionId}`);
console.log(`POST ${url.toString()}\n`);

const req = client.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(body);
      if (res.statusCode === 200 || res.statusCode === 201) {
        console.log(`✓ Success!`);
        console.log(`  orderId:   ${json.orderId}`);
        console.log(`  confirmed: ${json.confirmed}`);
        console.log('\nWebSocket event payment:confirmed emitted to subscribed clients.');
        console.log(`\nVerify: GET ${apiUrl}/api/v1/payments/order/${json.orderId}/pix-status`);
      } else {
        console.log(`✗ Failed (${res.statusCode}):`, JSON.stringify(json, null, 2));
      }
    } catch {
      console.log(`Status: ${res.statusCode}`);
      console.log('Raw response:', body);
    }
  });
});

req.on('error', (err) => {
  console.error('Request error:', err.message);
  process.exit(1);
});

req.end();
