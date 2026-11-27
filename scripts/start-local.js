/**
 * Starts the app against the local Firebase emulators (run `npm run emulators` first).
 * Local testing only: real logins, no dev shortcuts, nothing touches the live Firebase project.
 */
process.env.NODE_ENV = 'development';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
require('dotenv').config();
require('../server').startServer();
