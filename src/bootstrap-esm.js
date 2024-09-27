/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

/**
 * @import { INLSConfiguration } from './vs/nls'
 * @import { IProductConfiguration } from './vs/base/common/product'
 */

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire, register } from 'node:module';
import { product, pkg } from './bootstrap-meta.js';
import './bootstrap-node.js';
import * as performance from './vs/base/common/performance.js';

/** @ts-ignore */
const require = createRequire(import.meta.url);
/** @type any */
const module = { exports: {} };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Install a hook to module resolution to map 'fs' to 'original-fs'
if (process.env['ELECTRON_RUN_AS_NODE'] || process.versions['electron']) {
	const jsCode = `
	export async function resolve(specifier, context, nextResolve) {
		if (specifier === 'fs') {
			return {
				format: 'builtin',
				shortCircuit: true,
				url: 'node:original-fs'
			};
		}

		// Defer to the next hook in the chain, which would be the
		// Node.js default resolve if this is the last user-specified loader.
		return nextResolve(specifier, context);
	}`;
	register(`data:text/javascript;base64,${Buffer.from(jsCode).toString('base64')}`, import.meta.url);
}

// VSCODE_GLOBALS: package/product.json
/** @type Partial<IProductConfiguration> */
globalThis._VSCODE_PRODUCT_JSON = { ...product };
if (process.env['VSCODE_DEV']) {
	// Patch product overrides when running out of sources
	try {
		// @ts-ignore
		const overrides = require('../product.overrides.json');
		globalThis._VSCODE_PRODUCT_JSON = Object.assign(globalThis._VSCODE_PRODUCT_JSON, overrides);
	} catch (error) { /* ignore */ }
}
globalThis._VSCODE_PACKAGE_JSON = { ...pkg };

// VSCODE_GLOBALS: file root of all resources
globalThis._VSCODE_FILE_ROOT = __dirname;

//#region NLS helpers

/** @type {Promise<INLSConfiguration | undefined> | undefined} */
let setupNLSResult = undefined;

/**
 * @returns {Promise<INLSConfiguration | undefined>}
 */
function setupNLS() {
	if (!setupNLSResult) {
		setupNLSResult = doSetupNLS();
	}

	return setupNLSResult;
}

/**
 * @returns {Promise<INLSConfiguration | undefined>}
 */
async function doSetupNLS() {
	performance.mark('code/willLoadNls');

	/** @type {INLSConfiguration | undefined} */
	let nlsConfig = undefined;

	/** @type {string | undefined} */
	let messagesFile;
	if (process.env['VSCODE_NLS_CONFIG']) {
		try {
			/** @type {INLSConfiguration} */
			nlsConfig = JSON.parse(process.env['VSCODE_NLS_CONFIG']);
			if (nlsConfig?.languagePack?.messagesFile) {
				messagesFile = nlsConfig.languagePack.messagesFile;
			} else if (nlsConfig?.defaultMessagesFile) {
				messagesFile = nlsConfig.defaultMessagesFile;
			}

			globalThis._VSCODE_NLS_LANGUAGE = nlsConfig?.resolvedLanguage;
		} catch (e) {
			console.error(`Error reading VSCODE_NLS_CONFIG from environment: ${e}`);
		}
	}

	if (
		process.env['VSCODE_DEV'] ||	// no NLS support in dev mode
		!messagesFile					// no NLS messages file
	) {
		return undefined;
	}

	try {
		globalThis._VSCODE_NLS_MESSAGES = JSON.parse((await fs.promises.readFile(messagesFile)).toString());
	} catch (error) {
		console.error(`Error reading NLS messages file ${messagesFile}: ${error}`);

		// Mark as corrupt: this will re-create the language pack cache next startup
		if (nlsConfig?.languagePack?.corruptMarkerFile) {
			try {
				await fs.promises.writeFile(nlsConfig.languagePack.corruptMarkerFile, 'corrupted');
			} catch (error) {
				console.error(`Error writing corrupted NLS marker file: ${error}`);
			}
		}

		// Fallback to the default message file to ensure english translation at least
		if (nlsConfig?.defaultMessagesFile && nlsConfig.defaultMessagesFile !== messagesFile) {
			try {
				globalThis._VSCODE_NLS_MESSAGES = JSON.parse((await fs.promises.readFile(nlsConfig.defaultMessagesFile)).toString());
			} catch (error) {
				console.error(`Error reading default NLS messages file ${nlsConfig.defaultMessagesFile}: ${error}`);
			}
		}
	}

	performance.mark('code/didLoadNls');

	return nlsConfig;
}

//#endregion

//#region ESM Loading

/**
 * @param {string=} esModule
 * @param {(value: any) => void} [onLoad]
 * @param {(err: Error) => void} [onError]
 */
module.exports.load = function (esModule, onLoad, onError) {
	if (!esModule) {
		return;
	}

	onLoad = onLoad || function () { };
	onError = onError || function (err) { console.error(err); };

	setupNLS().then(() => {
		performance.mark(`code/fork/willLoadCode`);
		import([`./${esModule}.js`].join('/') /* workaround to prevent esbuild from inlining this */).then(onLoad, onError);
	});
};

//#endregion

export const load = module.exports.load;
