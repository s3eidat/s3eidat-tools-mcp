#!/usr/bin/env node
import { main } from './server.js';

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
