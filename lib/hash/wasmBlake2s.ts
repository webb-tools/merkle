// IMPORTS
// ================================================================================================
import { instantiateBlake2s } from '../assembly';

// MODULE VARIABLES
// ================================================================================================
export const digestSize = 32;

const wasm = instantiateBlake2s();
const i1Ref = wasm.getInput1Ref();
const i2Ref = wasm.getInput2Ref();
const oRef = wasm.getOutputRef();
const oEnd = oRef + digestSize;

// PUBLIC FUNCTIONS
// ================================================================================================
export function wasmBlake2s256(v1: Buffer, v2?: Buffer): Buffer {
    if (v2 === undefined) {
        if (v1.byteLength === 32) {
            wasm.U8.set(v1, i1Ref);
            wasm.hash1(i1Ref, oRef);
            return Buffer.from(wasm.U8.slice(oRef, oEnd));
        }
        else {
            const vRef = wasm.newArray(v1.byteLength);
            wasm.U8.set(v1, vRef);
            wasm.hash3(vRef, v1.byteLength, oRef);
            wasm.__release(vRef);
            return Buffer.from(wasm.U8.slice(oRef, oEnd));
        }
    }
    else {
        wasm.U8.set(v1, i1Ref);
        wasm.U8.set(v2, i2Ref);
        wasm.hash2(i1Ref, i2Ref, oRef);
        return Buffer.from(wasm.U8.slice(oRef, oEnd));
    }
}