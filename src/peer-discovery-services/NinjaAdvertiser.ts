import { TaggedBEEF } from '@bsv/overlay/TaggedBEEF.ts'
import pushdrop from 'pushdrop'
import { Ninja, NinjaGetTransactionOutputsResultApi } from 'ninja-base'
import { toBEEFfromEnvelope } from '@babbage/sdk-ts'
import { Transaction, Script, PublicKey, PrivateKey } from '@bsv/sdk'
import { Advertiser } from '@bsv/overlay/Advertiser.ts'
import { SHIPAdvertisement } from '@bsv/overlay/SHIPAdvertisement.ts'
import { SLAPAdvertisement } from '@bsv/overlay/SLAPAdvertisement.ts'
import { createAdvertisement } from './utils/createAdvertisement.js'
import { getPaymentPrivateKey } from 'sendover'

/**
 * Implements the Advertiser interface for managing SHIP and SLAP advertisements using a Ninja.
 */
export class NinjaAdvertiser implements Advertiser {
  ninja: Ninja

  /**
   * Constructs a new NinjaAdvertiser instance.
   * @param privateKey - The private key used for signing transactions.
   * @param dojoURL - The URL of the dojo server for the Ninja.
   * @param hostingDomain - The base server URL for the NinjaAdvertiser.
   */
  constructor(
    public privateKey: string,
    public dojoURL: string,
    public hostingDomain: string
  ) {
    this.ninja = new Ninja({
      privateKey,
      config: {
        dojoURL
      }
    })
  }

  /**
   * Creates a new SHIP advertisement.
   * @param topic - The topic name for the SHIP advertisement.
   * @returns A promise that resolves to the created SHIP advertisement as TaggedBEEF.
   */
  async createSHIPAdvertisement(topic: string): Promise<TaggedBEEF> {
    return await createAdvertisement(
      this.privateKey,
      'SHIP',
      this.hostingDomain,
      topic,
      this.ninja,
      'SHIP Advertisement Issuance'
    )
  }

  /**
   * Creates a new SLAP advertisement.
   * @param service - The service name for the SLAP advertisement.
   * @returns A promise that resolves to the created SLAP advertisement as TaggedBEEF.
   */
  async createSLAPAdvertisement(service: string): Promise<TaggedBEEF> {
    return await createAdvertisement(
      this.privateKey,
      'SLAP',
      this.hostingDomain,
      service,
      this.ninja,
      'SLAP Advertisement Issuance'
    )
  }

  /**
   * Finds all SHIP advertisements for a given topic.
   * @param topic - The topic name to search for.
   * @returns A promise that resolves to an array of SHIP advertisements.
   */
  async findAllSHIPAdvertisements(): Promise<SHIPAdvertisement[]> {
    const advertisements: SHIPAdvertisement[] = []
    // Note: consider using tags
    const results = await this.ninja.getTransactionOutputs({
      basket: 'tm_ship',
      includeBasket: true,
      spendable: true
      // type: 'output',
      // tagQueryMode: 'all',
      // limit: 100 // Adjust as needed
    })

    results.forEach((output: NinjaGetTransactionOutputsResultApi) => {
      try {
        const beef = toBEEFfromEnvelope({
          txid: output.txid,
          rawTx: output.envelope?.rawTx as string,
          proof: output.envelope?.proof,
          inputs: output.envelope?.inputs
        }).beef

        const fields = pushdrop.decode({
          script: output.outputScript,
          fieldFormat: 'buffer'
        }).fields

        // Return advertisement details
        if (fields.length >= 4) {
          advertisements.push({
            protocol: fields[0].toString(),
            identityKey: fields[1].toString('hex'),
            domain: fields[2].toString(),
            topic: fields[3].toString(),
            beef,
            outputIndex: output.vout
          })
        }
      } catch (error) {
        console.error('Failed to parse SHIP token')
      }
    })

    return advertisements
  }

  /**
   * Finds all SLAP advertisements for a given service.
   * @param service - The service name to search for.
   * @returns A promise that resolves to an array of SLAP advertisements.
   */
  async findAllSLAPAdvertisements(): Promise<SLAPAdvertisement[]> {
    const results = await this.ninja.getTransactionOutputs({
      basket: 'tm_slap',
      includeBasket: true,
      spendable: true
    })

    const advertisements: SLAPAdvertisement[] = []
    results.forEach((output: NinjaGetTransactionOutputsResultApi) => {
      try {
        const beef = toBEEFfromEnvelope({
          txid: output.txid,
          rawTx: output.envelope?.rawTx as string,
          inputs: output.envelope?.inputs,
          proof: output.envelope?.proof
        }).beef

        const fields = pushdrop.decode({
          script: output.outputScript,
          fieldFormat: 'buffer'
        }).fields

        // Return advertisement details
        if (fields.length >= 4) {
          advertisements.push({
            protocol: fields[0].toString(),
            identityKey: fields[1].toString('hex'),
            domain: fields[2].toString(),
            service: fields[3].toString(),
            beef,
            outputIndex: output.vout
          })
        }
      } catch (error) {
        console.error('Failed to parse SLAP token')
      }
    })
    return advertisements
  }

  /**
   * Revokes an existing advertisement.
   * @param advertisement - The advertisement to revoke, either SHIP or SLAP.
   * @returns A promise that resolves to the revoked advertisement as TaggedBEEF.
   */
  async revokeAdvertisement(advertisement: SHIPAdvertisement | SLAPAdvertisement): Promise<TaggedBEEF> {
    if (advertisement.beef === undefined || advertisement.outputIndex === undefined) {
      throw new Error('Advertisement to revoke must contain tagged beef!')
    }
    // Parse the transaction and UTXO to spend
    const advertisementTx = Transaction.fromBEEF(advertisement.beef)
    const adTxid = advertisementTx.id('hex')
    const outputToRedeem = advertisementTx.outputs[advertisement.outputIndex]
    const identityKey = PublicKey.fromPrivateKey(new PrivateKey(this.privateKey, 'hex')).toString()

    // Derive a unlocking private key using BRC-42 derivation scheme
    const derivedPrivateKey = getPaymentPrivateKey({
      recipientPrivateKey: this.privateKey,
      senderPublicKey: identityKey,
      invoiceNumber: `2-${advertisement.protocol}-1`,
      returnType: 'hex'
    })

    const unlockingScript = await pushdrop.redeem({
      key: derivedPrivateKey,
      prevTxId: adTxid,
      outputIndex: advertisement.outputIndex,
      lockingScript: outputToRedeem.lockingScript.toHex(),
      outputAmount: outputToRedeem.satoshis
    })

    // Create a new transaction that spends the SHIP or SLAP advertisement issuance token
    const revokeTx = await this.ninja.getTransactionWithOutputs({
      inputs: {
        [adTxid]: {
          rawTx: advertisementTx.toHex(),
          outputsToRedeem: [{
            index: advertisement.outputIndex,
            unlockingScript
          }]
        }
      },
      outputs: [],
      labels: [],
      note: `Revoke ${advertisement.protocol} advertisement`,
      autoProcess: true
    })

    const beef = toBEEFfromEnvelope({
      rawTx: revokeTx.rawTx as string,
      inputs: revokeTx.inputs,
      txid: revokeTx.txid
    }).beef

    return {
      beef,
      topics: [advertisement.protocol === 'SHIP' ? 'tm_ship' : 'tm_slap']
    }
  }

  /**
   * Parses an advertisement from the provided output script.
   * @param outputScript - The output script to parse.
   * @returns A SHIPAdvertisement or SLAPAdvertisement if the script matches the expected format, otherwise null.
   */
  parseAdvertisement(outputScript: Script): SHIPAdvertisement | SLAPAdvertisement | null {
    try {
      const result = pushdrop.decode({
        script: outputScript.toHex(),
        fieldFormat: 'buffer'
      })

      if (result.fields.length < 4) {
        return null
      }
      const protocol = result.fields[0].toString()
      const identityKey = result.fields[1].toString('hex')
      const domain = result.fields[2].toString()
      const topicOrServiceName = result.fields[3].toString()

      if (protocol === 'SHIP') {
        return {
          protocol: 'SHIP',
          identityKey,
          domain,
          topic: topicOrServiceName
        }
      } else if (protocol === 'SLAP') {
        return {
          protocol: 'SLAP',
          identityKey,
          domain,
          service: topicOrServiceName
        }
      } else {
        return null
      }
    } catch (error) {
      console.error('Error parsing advertisement:', error)
      return null
    }
  }
}
