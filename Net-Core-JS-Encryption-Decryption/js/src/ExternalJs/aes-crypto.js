/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ''AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/* global crypto, TextEncoder */

"use strict";


const ERR_INVALID_PASSWORD = "Invalid pasword";
const BLOCK_LENGTH = 16;
const RAW_FORMAT = "raw";
const PBKDF2_ALGORITHM = { name: "PBKDF2" };
const SIGNATURE_ALGORITHM = { name: "HMAC" };
const HASH_FUNCTION = "SHA-1";
const BASE_KEY_ALGORITHM = Object.assign({ hash: SIGNATURE_ALGORITHM }, PBKDF2_ALGORITHM);
const DERIVED_BITS_ALGORITHM = Object.assign({ iterations: 1000, hash: { name: HASH_FUNCTION } }, PBKDF2_ALGORITHM);
const AUTHENTICATION_ALGORITHM = Object.assign({ hash: HASH_FUNCTION }, SIGNATURE_ALGORITHM);
const DERIVED_BITS_USAGE = ["deriveBits"];
const SIGN_USAGE = ["sign"];
const SALT_LENGTH = [8, 12, 16];
const KEY_LENGTH = [16, 24, 32];
const SIGNATURE_LENGTH = 10;
const COUNTER_DEFAULT_VALUE = [0, 0, 0, 0];
const subtle = crypto.subtle;

class AESDecrypt {

	constructor(password, signed, strength) {
		Object.assign(this, {
			password,
			signed,
			strength: strength - 1,
			input: signed && new Uint8Array(0),
			pendingInput: new Uint8Array(0)
		});
	}

	async append(input) {
		const aesCrypto = this;
		if (aesCrypto.password) {
			const preambule = input.subarray(0, SALT_LENGTH[aesCrypto.strength] + 2);
			await createDecryptionKeys(aesCrypto, preambule, aesCrypto.password);
			aesCrypto.password = null;
			aesCrypto.aesCtrGladman = new mode.ctrGladman(new cipher.aes(aesCrypto.keys.key), Array.from(COUNTER_DEFAULT_VALUE));
			input = input.subarray(SALT_LENGTH[aesCrypto.strength] + 2);
		}
		let output = new Uint8Array(input.length - SIGNATURE_LENGTH - ((input.length - SIGNATURE_LENGTH) % BLOCK_LENGTH));
		let bufferedInput = input;
		if (aesCrypto.pendingInput.length) {
			bufferedInput = concat(aesCrypto.pendingInput, input);
			output = expand(output, bufferedInput.length - SIGNATURE_LENGTH - ((bufferedInput.length - SIGNATURE_LENGTH) % BLOCK_LENGTH));
		}
		let offset;
		for (offset = 0; offset <= bufferedInput.length - SIGNATURE_LENGTH - BLOCK_LENGTH; offset += BLOCK_LENGTH) {
			const inputChunk = bufferedInput.subarray(offset, offset + BLOCK_LENGTH);
			const chunkToDecrypt = codec.bytes.toBits(inputChunk);
			const outputChunk = aesCrypto.aesCtrGladman.update(chunkToDecrypt);
			output.set(codec.bytes.fromBits(outputChunk), offset);
		}
		aesCrypto.pendingInput = bufferedInput.subarray(offset);
		if (aesCrypto.signed) {
			aesCrypto.input = concat(aesCrypto.input, input);
		}
		return output;
	}

	async flush() {
		const aesCrypto = this;
		const pendingInput = aesCrypto.pendingInput;
		const keys = aesCrypto.keys;
		const chunkToDecrypt = pendingInput.subarray(0, pendingInput.length - SIGNATURE_LENGTH);
		const originalSignatureArray = pendingInput.subarray(pendingInput.length - SIGNATURE_LENGTH);
		let decryptedChunkArray = new Uint8Array(0);
		if (chunkToDecrypt.length) {
			const decryptedChunk = aesCrypto.aesCtrGladman.update(codec.bytes.toBits(chunkToDecrypt));
			decryptedChunkArray = codec.bytes.fromBits(decryptedChunk);
		}
		let valid = true;
		if (aesCrypto.signed) {
			const signature = await subtle.sign(SIGNATURE_ALGORITHM, keys.authentication, aesCrypto.input.subarray(0, aesCrypto.input.length - SIGNATURE_LENGTH));
			const signatureArray = new Uint8Array(signature).subarray(0, SIGNATURE_LENGTH);
			aesCrypto.input = null;
			for (let indexSignature = 0; indexSignature < SIGNATURE_LENGTH; indexSignature++) {
				if (signatureArray[indexSignature] != originalSignatureArray[indexSignature]) {
					valid = false;
				}
			}
		}
		return {
			valid,
			data: decryptedChunkArray
		};
	}

}

class AESEncrypt {

	constructor(password, strength) {
		Object.assign(this, {
			password,
			strength: strength - 1,
			output: new Uint8Array(0),
			pendingInput: new Uint8Array(0)
		});
	}

	async append(input) {
		const aesCrypto = this;
		let preambule = new Uint8Array(0);
		if (aesCrypto.password) {
			preambule = await createEncryptionKeys(aesCrypto, aesCrypto.password);
			aesCrypto.password = null;
			aesCrypto.aesCtrGladman = new mode.ctrGladman(new cipher.aes(aesCrypto.keys.key), Array.from(COUNTER_DEFAULT_VALUE));
		}
		let output = new Uint8Array(preambule.length + input.length - (input.length % BLOCK_LENGTH));
		output.set(preambule, 0);
		if (aesCrypto.pendingInput.length) {
			input = concat(aesCrypto.pendingInput, input);
			output = expand(output, input.length - (input.length % BLOCK_LENGTH));
		}
		let offset;
		for (offset = 0; offset <= input.length - BLOCK_LENGTH; offset += BLOCK_LENGTH) {
			const chunkToEncrypt = codec.bytes.toBits(input.subarray(offset, offset + BLOCK_LENGTH));
			const outputChunk = aesCrypto.aesCtrGladman.update(chunkToEncrypt);
			output.set(codec.bytes.fromBits(outputChunk), offset + preambule.length);
		}
		aesCrypto.pendingInput = input.subarray(offset);
		aesCrypto.output = concat(aesCrypto.output, output);
		return output;
	}

	async flush() {
		const aesCrypto = this;
		let encryptedChunkArray = new Uint8Array(0);
		if (aesCrypto.pendingInput.length) {
			const encryptedChunk = aesCrypto.aesCtrGladman.update(codec.bytes.toBits(aesCrypto.pendingInput));
			encryptedChunkArray = codec.bytes.fromBits(encryptedChunk);
			aesCrypto.output = concat(aesCrypto.output, encryptedChunkArray);
		}
		const signature = await subtle.sign(SIGNATURE_ALGORITHM, aesCrypto.keys.authentication, aesCrypto.output.subarray(SALT_LENGTH[aesCrypto.strength] + 2));
		aesCrypto.output = null;
		const signatureArray = new Uint8Array(signature).subarray(0, SIGNATURE_LENGTH);
		return {
			data: concat(encryptedChunkArray, signatureArray),
			signature: signatureArray
		};
	}
}


async function createDecryptionKeys(decrypt, preambuleArray, password) {
	await createKeys(decrypt, password, preambuleArray.subarray(0, SALT_LENGTH[decrypt.strength]));
	const passwordVerification = preambuleArray.subarray(SALT_LENGTH[decrypt.strength]);
	const passwordVerificationKey = decrypt.keys.passwordVerification;
	if (passwordVerificationKey[0] != passwordVerification[0] || passwordVerificationKey[1] != passwordVerification[1]) {
		throw new Error(ERR_INVALID_PASSWORD);
	}
}

async function createEncryptionKeys(encrypt, password) {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH[encrypt.strength]));
	await createKeys(encrypt, password, salt);
	return concat(salt, encrypt.keys.passwordVerification);
}

async function createKeys(target, password, salt) {
	const encodedPassword = (new TextEncoder()).encode(password);
	const basekey = await subtle.importKey(RAW_FORMAT, encodedPassword, BASE_KEY_ALGORITHM, false, DERIVED_BITS_USAGE);
	const derivedBits = await subtle.deriveBits(Object.assign({ salt }, DERIVED_BITS_ALGORITHM), basekey, 8 * ((KEY_LENGTH[target.strength] * 2) + 2));
	const compositeKey = new Uint8Array(derivedBits);
	target.keys = {
		key: codec.bytes.toBits(compositeKey.subarray(0, KEY_LENGTH[target.strength])),
		authentication: await subtle.importKey(RAW_FORMAT, compositeKey.subarray(KEY_LENGTH[target.strength], KEY_LENGTH[target.strength] * 2), AUTHENTICATION_ALGORITHM, false, SIGN_USAGE),
		passwordVerification: compositeKey.subarray(KEY_LENGTH[target.strength] * 2)
	};
}

function concat(leftArray, rightArray) {
	let array = leftArray;
	if (leftArray.length + rightArray.length) {
		array = new Uint8Array(leftArray.length + rightArray.length);
		array.set(leftArray, 0);
		array.set(rightArray, leftArray.length);
	}
	return array;
}

function expand(inputArray, length) {
	if (length && length > inputArray.length) {
		const array = inputArray;
		inputArray = new Uint8Array(length);
		inputArray.set(array, 0);
	}
	return inputArray;
}