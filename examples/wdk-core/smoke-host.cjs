const { createConnection } = require('bare-net');
const { pathToFileURL } = require('bare-url');
const { load } = require('bare-module');
const Buffer = require('bare-buffer');

const ipc = createConnection({ host: '127.0.0.1', port: Number(Bare.argv[3]) });
globalThis.BareKit = { IPC: ipc };
ipc.once('end', () => Bare.exit(0));
ipc.once('error', (error) => {
  console.error(error);
  Bare.exit(1);
});

const filename = Bare.argv[2];
const data = Buffer.from(require(filename), 'utf8');
load(pathToFileURL(filename.replace(/\.js$/, '')), data).catch((error) => {
  console.error(error);
  Bare.exit(1);
});
