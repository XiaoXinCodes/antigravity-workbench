// Preload before production modules. New dependency paths must never escape a
// synthetic transport just because an older fixture forgot to intercept them.
const http = require('node:http'), https = require('node:https');
for (const transport of [http, https]) {
  for (const method of ['request', 'get']) {
    const original = transport[method];
    transport[method] = function (options, ...args) {
      const host = typeof options === 'string' || options instanceof URL ? new URL(options).hostname : options.hostname ?? options.host;
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw Error('TEST_EXTERNAL_NETWORK_BLOCKED');
      return original.call(this, options, ...args);
    };
  }
}
globalThis.fetch = async () => { throw Error('TEST_EXTERNAL_NETWORK_BLOCKED'); };
