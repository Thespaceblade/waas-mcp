#!/usr/bin/env node
import { runLoginFlow } from "./session.js";

runLoginFlow().catch((error) => {
  console.error(error);
  process.exit(1);
});
