/*
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import path from 'path';

import {
  addPath,
  debug as logDebug,
  getInput,
  info as logInfo,
  setFailed,
  setOutput,
  warning as logWarning,
} from '@actions/core';
import { getExecOutput } from '@actions/exec';
import * as toolCache from '@actions/tool-cache';

import {
  authenticateGcloudSDK,
  getLatestGcloudSDKVersion,
  getToolCommand,
  installComponent as installGcloudComponent,
  installGcloudSDK,
  isInstalled as isGcloudInstalled,
} from '@google-github-actions/setup-cloud-sdk';

import {
  errorMessage,
  isPinnedToHead,
  parseBoolean,
  parseFlags,
  pinnedToHeadWarning,
  presence,
  stubEnv,
} from '@google-github-actions/actions-utils';

import { parseDeployResponse, parseDescribeResponse } from './output-parser';

// Do not listen to the linter - this can NOT be rewritten as an ES6 import
// statement.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: appVersion } = require('../package.json');

/**
 * Executes the main action. It includes the main business logic and is the
 * primary entry point. It is documented inline.
 */
export async function run(): Promise<void> {
  // Register metrics
  const restoreEnv = stubEnv({
    CLOUDSDK_METRICS_ENVIRONMENT: 'github-actions-deploy-appengine',
    CLOUDSDK_METRICS_ENVIRONMENT_VERSION: appVersion,
  });

  // Warn if pinned to HEAD
  if (isPinnedToHead()) {
    logWarning(pinnedToHeadWarning('v1'));
  }

  try {
    // Get action inputs.
    const projectId = presence(getInput('project_id'));
    const cwd = presence(getInput('working_directory'));
    const deliverables = (presence(getInput('deliverables')) || 'app.yaml').split(' ');
    const imageUrl = presence(getInput('image_url'));
    const version = presence(getInput('version'));
    const promote = parseBoolean(getInput('promote'));
    const flags = presence(getInput('flags'));
    const gcloudVersion = await computeGcloudVersion(getInput('gcloud_version'));
    const gcloudComponent = presence(getInput('gcloud_component'));

    // Validate gcloud component input
    if (gcloudComponent && gcloudComponent !== 'alpha' && gcloudComponent !== 'beta') {
      throw new Error(`invalid value for gcloud_component: ${gcloudComponent}`);
    }

    // Change working directory
    if (cwd) {
      logInfo(`Changing into working directory: ${cwd}`);
      process.chdir(cwd.trim());
    }

    // Validate deliverables
    for (const deliverable of deliverables) {
      if (!fs.existsSync(deliverable)) {
        const message =
          `Deliverable ${deliverable} can not be found. ` +
          'Check `working_directory` and `deliverables` input paths.';
        throw new Error(message);
      }
    }

    const toolCommand = getToolCommand();

    // Create app engine gcloud cmd.
    let appDeployCmd = ['app', 'deploy', '--quiet', '--format', 'json', ...deliverables];

    // Add gcloud flags.
    if (projectId) {
      appDeployCmd.push('--project', projectId);
    }
    if (imageUrl) {
      appDeployCmd.push('--image-url', imageUrl);
    }
    if (version) {
      appDeployCmd.push('--version', version);
    }
    if (promote) {
      appDeployCmd.push('--promote');
    } else {
      appDeployCmd.push('--no-promote');
    }

    // Add optional flags
    if (flags) {
      const flagList = parseFlags(flags);
      if (flagList) appDeployCmd = appDeployCmd.concat(flagList);
    }

    // Install gcloud if not already installed.
    if (!isGcloudInstalled(gcloudVersion)) {
      await installGcloudSDK(gcloudVersion);
    } else {
      const toolPath = toolCache.find('gcloud', gcloudVersion);
      addPath(path.join(toolPath, 'bin'));
    }

    // Install gcloud component if needed and prepend the command
    if (gcloudComponent) {
      await installGcloudComponent(gcloudComponent);
      appDeployCmd.unshift(gcloudComponent);
    }

    // Authenticate - this comes from google-github-actions/auth.
    const credFile = process.env.GOOGLE_GHA_CREDS_PATH;
    if (credFile) {
      await authenticateGcloudSDK(credFile);
      logInfo('Successfully authenticated');
    } else {
      logWarning('No authentication found, authenticate with `google-github-actions/auth`.');
    }

    const options = { silent: true, ignoreReturnCode: true };
    const deployCommandString = `${toolCommand} ${appDeployCmd.join(' ')}`;
    logInfo(`Running: ${deployCommandString}`);

    // Get output of gcloud cmd.
    const deployOutput = await getExecOutput(toolCommand, appDeployCmd, options);
    if (deployOutput.exitCode !== 0) {
      const errMsg =
        deployOutput.stderr || `command exited ${deployOutput.exitCode}, but stderr had no output`;
      throw new Error(`failed to execute gcloud command \`${deployCommandString}\`: ${errMsg}`);
    }

    // Extract the version from the response.
    const deployResponse = parseDeployResponse(deployOutput.stdout);
    logDebug(`Deployed new version: ${JSON.stringify(deployResponse)}`);

    // Look up the new version to get metadata.
    const appVersionsDescribeCmd = ['app', 'versions', 'describe', '--quiet', '--format', 'json'];
    appVersionsDescribeCmd.push('--project', deployResponse.project);
    appVersionsDescribeCmd.push('--service', deployResponse.service);
    appVersionsDescribeCmd.push(deployResponse.versionID);

    // Prepend component to command (it was already installed above)
    if (gcloudComponent) {
      appVersionsDescribeCmd.unshift(gcloudComponent);
    }

    const describeCommandString = `${toolCommand} ${appVersionsDescribeCmd.join(' ')}`;
    logInfo(`Running: ${describeCommandString}`);

    const describeOutput = await getExecOutput(toolCommand, appVersionsDescribeCmd, options);
    if (describeOutput.exitCode !== 0) {
      const errMsg =
        describeOutput.stderr ||
        `command exited ${describeOutput.exitCode}, but stderr had no output`;
      throw new Error(`failed to execute gcloud command \`${describeCommandString}\`: ${errMsg}`);
    }

    // Parse the describe response.
    const describeResponse = parseDescribeResponse(describeOutput.stdout);

    // Set outputs.
    setOutput('name', describeResponse.name);
    setOutput('runtime', describeResponse.runtime);
    setOutput('service_account_email', describeResponse.serviceAccountEmail);
    setOutput('serving_status', describeResponse.servingStatus);
    setOutput('version_id', describeResponse.versionID);
    setOutput('version_url', describeResponse.versionURL);

    // Backwards compatability.
    setOutput('serviceAccountEmail', describeResponse.serviceAccountEmail);
    setOutput('versionURL', describeResponse.versionURL);
    setOutput('url', describeResponse.versionURL);
  } catch (err) {
    const msg = errorMessage(err);
    setFailed(`google-github-actions/deploy-appengine failed with: ${msg}`);
  } finally {
    restoreEnv();
  }
}

/**
 * computeGcloudVersion computes the appropriate gcloud version for the given
 * string.
 */
async function computeGcloudVersion(str: string): Promise<string> {
  str = (str || '').trim();
  if (str === '' || str === 'latest') {
    return await getLatestGcloudSDKVersion();
  }
  return str;
}

// Execute this as the entrypoint when requested.
if (require.main === module) {
  run();
}
