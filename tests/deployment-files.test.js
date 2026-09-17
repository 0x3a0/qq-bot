import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function workspaceFile(relativePath) {
  return fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
}

test("deployment compose file pulls a published image and keeps runtime secrets external", () => {
  const compose = readFileSync(workspaceFile("docker-compose.yml"), "utf8");
  const dockerignore = readFileSync(workspaceFile(".dockerignore"), "utf8");

  assert.match(compose, /image: \$\{QQ_MARKET_BOT_IMAGE:-ghcr\.io\/0x3a0\/qq-bot:latest\}/);
  assert.doesNotMatch(compose, /^\s*build:/m);
  assert.match(compose, /env_file: \.env/);
  assert.match(dockerignore, /^\.env$/m);
});

test("deployment script validates required configuration and restores a failed update", () => {
  const script = readFileSync(workspaceFile("scripts/deploy-image.sh"), "utf8");

  assert.match(script, /require_configured_value ONEBOT_WS_URL/);
  assert.match(script, /require_configured_value THS_API_KEY/);
  assert.match(script, /docker pull "\$\{IMAGE_REF\}"/);
  assert.match(script, /if ! run_container "\$\{IMAGE_REF\}"/);
  assert.match(script, /Restoring the previous image/);
});

test("GitHub workflow publishes immutable and rolling GHCR image tags", () => {
  const workflow = readFileSync(workspaceFile(".github/workflows/publish-image.yml"), "utf8");

  assert.match(workflow, /packages: write/);
  assert.match(workflow, /ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/qq-bot/);
  assert.match(workflow, /\$\{IMAGE_NAME\}:\$\{GITHUB_SHA\}/);
  assert.match(workflow, /\$\{IMAGE_NAME\}:latest/);
});
