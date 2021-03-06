// IMPORTS
// ================================================================================================
import { Hash, HashAlgorithm, Vector, WasmOptions } from "@guildofweavers/merkle";
import { instantiateBlake2s, WasmBlake2s as Blake2sWasm } from '../assembly';
import { WasmVector } from "../vectors/WasmVector";

// MODULE VARIABLES
// ================================================================================================
const DIGEST_SIZE = 32; // 32 bytes
const NULL_BUFFER = Buffer.alloc(DIGEST_SIZE);

// CLASS DEFINITION
// ================================================================================================
export class WasmBlake2s implements Hash {

    readonly wasm   : Blake2sWasm;
    readonly iRef   : number;
    readonly oRef   : number;
    readonly oEnd   : number;

    // CONSTRUCTOR
    // --------------------------------------------------------------------------------------------
    constructor(options: WasmOptions) {
        this.wasm = instantiateBlake2s(options.memory);
        this.iRef = this.wasm.getInputsRef();
        this.oRef = this.wasm.getOutputRef();
        this.oEnd = this.oRef + DIGEST_SIZE;
    }

    // PROPERTY ACCESSORS
    // --------------------------------------------------------------------------------------------
    get algorithm(): HashAlgorithm {
        return "blake2s256";
    }

    get digestSize(): number {
        return DIGEST_SIZE;
    }

    get isOptimized(): boolean {
        return true;
    }

    // PUBLIC METHODS
    // --------------------------------------------------------------------------------------------
    digest(value: Buffer): Buffer {
        let memU8 = new Uint8Array(this.wasm.memory.buffer);
        // TODO: investigate checking if the buffer comes from shared memory
        if (value.byteLength < 4096) {
            memU8.set(value, this.iRef);
            this.wasm.hash(this.iRef, value.byteLength, this.oRef);
        }
        else {
            const vRef = this.wasm.newArray(value.byteLength);
            if (memU8.buffer !== this.wasm.memory.buffer) {
                memU8 = new Uint8Array(this.wasm.memory.buffer);
            }
            memU8.set(value, vRef);
            this.wasm.hash(vRef, value.byteLength, this.oRef);
            this.wasm.__release(vRef);
        }
        return Buffer.from(memU8.subarray(this.oRef, this.oEnd));
    }

    merge(a: Buffer, b: Buffer): Buffer {
        const memU8 = new Uint8Array(this.wasm.memory.buffer);
        memU8.set(a, this.iRef);
        memU8.set(b, this.iRef + a.byteLength);
        this.wasm.hash(this.iRef, a.byteLength + b.byteLength, this.oRef);
        return Buffer.from(memU8.subarray(this.oRef, this.oEnd));
    }

    buildMerkleNodes(depth: number, leaves: Vector): ArrayBuffer {

        const wasm = this.wasm, iRef = this.iRef;

        // allocate memory for tree nodes
        const nodeCount = 1 << depth;
        const bufferLength = nodeCount * DIGEST_SIZE;
        const nRef = this.wasm.newArray(bufferLength);
        
        // build first row of internal nodes (parents of leaves)
        const parentCount = nodeCount >>> 1; // nodeCount / 2
        const evenLeafCount = (leaves.length & 1) ? leaves.length - 1 : leaves.length;
        let resRef = nRef + parentCount * DIGEST_SIZE;

        let lBuffer = leaves.toBuffer(), lRef = lBuffer.byteOffset, releaseLeaves = false;
        if (lBuffer.buffer !== wasm.memory.buffer) {
            // if the leaves buffer belongs to some other WASM memory, copy it into local memory
            lRef = wasm.newArray(lBuffer.byteLength);
            const memU8 = new Uint8Array(this.wasm.memory.buffer);
            memU8.set(lBuffer, lRef);
            releaseLeaves = true;
        }
        resRef = wasm.hashValues1(lRef, resRef, leaves.elementSize << 1, evenLeafCount >>> 1);

        // if the leaves were copied into local memory, free that memory
        if (releaseLeaves) {
            wasm.__release(lRef);
        }

        // if the number of leaves was odd, process the last leaf
        if (evenLeafCount !== leaves.length) {
            const lastLeaf = Buffer.from(lBuffer.slice(lBuffer.byteLength - leaves.elementSize));
            const memU8 = new Uint8Array(this.wasm.memory.buffer);
            memU8.set(lastLeaf, iRef);
            memU8.set(NULL_BUFFER, iRef + lastLeaf.length);
            wasm.hash(iRef, lastLeaf.length + DIGEST_SIZE, resRef);
            resRef += DIGEST_SIZE;
        }

        // if number of leaves was not a power of 2, assume all other leaves are NULL
        if (leaves.length < nodeCount) {
            const nullParent = this.merge(NULL_BUFFER, NULL_BUFFER);
            const resEnd = nRef + bufferLength;
            const memU8 = new Uint8Array(this.wasm.memory.buffer);
            while (resRef < resEnd) {
                memU8.set(nullParent, resRef);
                resRef += DIGEST_SIZE;
            }
        }

        // calculate all other tree nodes
        let tIndex = (parentCount - 1) * DIGEST_SIZE
        let sIndex = tIndex << 1;
        wasm.hashValues2(nRef + sIndex, nRef + tIndex, DIGEST_SIZE << 1, parentCount);

        // copy the buffer out of WASM memory, free the memory, and return the buffer
        const nBuffer = this.wasm.memory.buffer.slice(nRef, nRef + bufferLength);
        this.wasm.__release(nRef);
        return nBuffer;
    }

    mergeVectorRows(vectors: Vector[]): Vector {
        const elementCount = vectors[0].length;
        const elementSize  = vectors[0].elementSize;

        if (elementSize > 64) {
            throw new Error(`Cannot merge vector rows: vector element size must be smaller than 64 bytes`);
        }
        else if (64 % elementSize !== 0) {
            throw new Error(`Cannot merge vector rows: vector element size must be a divisor of 64`);
        }

        const vRefs = this.wasm.newArray(vectors.length * 8);
        const vIdx = vRefs >>> 3;
        const refsToRelease = new Set<number>();

        // build array of references to vectors
        let vRef: number;
        let memU8 = new Uint8Array(this.wasm.memory.buffer);
        for (let i = 0; i < vectors.length; i++) {
            let buffer = vectors[i].toBuffer();
            if (buffer.buffer === this.wasm.memory.buffer) {
                // if the vector is already in WASM memory, just cache the reference to it
                vRef = buffer.byteOffset;
            }
            else {
                // otherwise, copy the vector into WASM memory
                vRef = this.wasm.newArray(buffer.byteLength);
                if (memU8.buffer !== this.wasm.memory.buffer) {
                    memU8 = new Uint8Array(this.wasm.memory.buffer);
                }
                memU8.set(vectors[i].toBuffer(), vRef);
                refsToRelease.add(vRef);
            }
            const memU64 = new BigUint64Array(this.wasm.memory.buffer);
            memU64[vIdx + i] = BigInt(vRef);
        }

        const resRef = this.wasm.newArray(elementCount * DIGEST_SIZE);
        this.wasm.mergeArrayElements(vRefs, resRef, vectors.length, elementCount, elementSize);

        // release all memory that was used up during the operation
        this.wasm.__release(vRefs);
        for (let vRef of refsToRelease) {
            this.wasm.__release(vRef);
        }

        // build and return a vector with hashes
        return new WasmVector(this.wasm.memory, resRef, elementCount, DIGEST_SIZE);
    }

    digestValues(values: Buffer, valueSize: number): Vector {
        const elementCount = values.byteLength / valueSize;
        if (!Number.isInteger(elementCount)) {
            throw new Error('Values buffer cannot contain partial number of elements');
        }

        let vRef: number, releaseValues: boolean;
        if (this.wasm.memory.buffer === values.buffer) {
            // if the vector is already in WASM memory, just cache the reference to it
            vRef = values.byteOffset;
            releaseValues = false;
        }
        else {
            // otherwise, copy the vector into WASM memory
            vRef = this.wasm.newArray(values.byteLength);
            const memU8 = new Uint8Array(this.wasm.memory.buffer);
            memU8.set(values, vRef);
            releaseValues = true;
        }

        // allocate memory to hold the results and hash the values
        const resRef = this.wasm.newArray(elementCount * DIGEST_SIZE);
        this.wasm.hashValues1(vRef, resRef, valueSize, elementCount);

        // if the values were copied into WASM memory during the operation, free the memory
        if (releaseValues) {
            this.wasm.__release(vRef);
        }

        return new WasmVector(this.wasm.memory, resRef, elementCount, DIGEST_SIZE);
    }
}