#!/usr/bin/env node
// Bounded maximum-payload read sample; separate from P3 live fanout/latency acceptance.
import {runRemoteProductHarness} from "./product-harness.mjs";
await runRemoteProductHarness(30);
