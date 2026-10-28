import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>

function head(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value]
  if (value < 256) return [(major << 5) | 24, value]
  return [(major << 5) | 25, value >> 8, value & 0xff]
}

/** Just enough CBOR for an attestation object: ints, byte/text strings and maps. */
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') {
    return Buffer.from(value >= 0 ? head(0, value) : head(1, -1 - value))
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value)
    return Buffer.concat([Buffer.from(head(3, bytes.length)), bytes])
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([Buffer.from(head(2, value.length)), value])
  }
  const parts: Buffer[] = [Buffer.from(head(5, value.size))]
  for (const [k, v] of value) parts.push(cbor(k), cbor(v))
  return Buffer.concat(parts)
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()

interface CreationOptions {
  challenge: string
  rp: { id?: string }
}
interface RequestOptions {
  challenge: string
  rpId?: string
}

/** A passkey in software: makes the registration and sign-in responses a browser would. */
export class VirtualAuthenticator {
  readonly credentialId = randomBytes(32)
  private readonly privateKey: KeyObject
  private readonly publicKey: KeyObject
  private counter = 0
  userHandle = ''

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = pair.privateKey
    this.publicKey = pair.publicKey
  }

  /** Makes the next assertion reuse a counter value, like a cloned authenticator would. */
  rewind() {
    this.counter--
  }

  get id() {
    return b64(this.credentialId)
  }

  create(options: CreationOptions & { user: { id: string } }, origin: string) {
    this.userHandle = options.user.id
    const jwk = this.publicKey.export({ format: 'jwk' })
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ])
    const counter = Buffer.alloc(4)
    const idLength = Buffer.from([0, this.credentialId.length])
    // flags: user present, user verified, attested credential data included
    const authData = Buffer.concat([
      sha256(options.rp.id!),
      Buffer.from([0x45]),
      counter,
      Buffer.alloc(16),
      idLength,
      this.credentialId,
      cbor(coseKey),
    ])
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    )
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientData('webauthn.create', options.challenge, origin)),
        attestationObject: b64(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    }
  }

  get(options: RequestOptions, origin: string, rpId = options.rpId!) {
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(++this.counter)
    // flags: user present, user verified
    const authData = Buffer.concat([sha256(rpId), Buffer.from([0x05]), counter])
    const clientDataJSON = clientData('webauthn.get', options.challenge, origin)
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.privateKey,
    )
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    }
  }
}

function clientData(type: string, challenge: string, origin: string) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
}
