import assert from "node:assert/strict";

import { buildProjectHash, parseAppRoute } from "../src/routes.js";

function testHubRoutes() {
  assert.deepEqual(parseAppRoute(""), { name: "hub" });
  assert.deepEqual(parseAppRoute("#"), { name: "hub" });
  assert.deepEqual(parseAppRoute("#/"), { name: "hub" });
}

function testProjectRouteRoundTrip() {
  const localProjectKey = "project key/with reserved characters";
  const hash = buildProjectHash(localProjectKey);
  assert.equal(hash, "#/project/project%20key%2Fwith%20reserved%20characters");
  assert.deepEqual(parseAppRoute(hash), { name: "project", localProjectKey });
}

function testInvalidRoutesFailClosed() {
  assert.deepEqual(parseAppRoute("#/projects/example"), { name: "not-found" });
  assert.deepEqual(parseAppRoute("#/project/"), { name: "not-found" });
  assert.deepEqual(parseAppRoute("#/project/example/extra"), { name: "not-found" });
  assert.deepEqual(parseAppRoute("#/project/%E0%A4%A"), { name: "not-found" });
  assert.throws(() => buildProjectHash(""), /local project key/i);
}

testHubRoutes();
testProjectRouteRoundTrip();
testInvalidRoutesFailClosed();

console.log("route tests passed");
