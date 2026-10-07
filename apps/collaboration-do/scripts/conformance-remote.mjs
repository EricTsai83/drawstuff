#!/usr/bin/env node
// Protocol-6 product acceptance. Detailed malformed-frame contracts run in workerd unit tests.
import {runRemoteProductHarness} from "./product-harness.mjs";
await runRemoteProductHarness();
