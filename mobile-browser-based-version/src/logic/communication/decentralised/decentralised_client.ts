import msgpack from 'msgpack-lite'

import {
  makeID,
  authenticate
} from '../authenticator'
import {
  assignWeightsToModel,
  serializeWeights
} from '../tensor_serializer'
import { checkBufferUntil, checkBufferWeightsUntil } from './check_buffer'
import { Client } from '../client'
import { Task } from '@/logic/task_definition/base/task'
import { TrainingInformant } from '@/logic/training/training_informant'
import CMD_CODES from './communication_codes'
const Hashes = require('jshashes')

/**
 * NOTE: peer.js seems to convert all array types to ArrayBuffer, making the original
 * type unrecoverable (Float32Array, Uint8Array, ...). The solution is to encode any payload
 * with msgpack.encode, then decode at the destination.
 */

/**
 * The waiting time between performing requests to the centralized server.
 * Expressed in milliseconds.
 */
const TIME_PER_TRIES = 100
/**
 * The maximum number of tries before stopping to perform requests.
 */
const MAX_TRIES = 100

/**
 * Class that deals with communication with the PeerJS server.
 * Collects the list of receivers currently connected to the PeerJS server.
 */
export class DecentralisedClient extends Client {
  /**
   * Constructs the client for decentralised training.
   * @param {String} serverURL
   * @param {String} taskID
   * @param {String} taskPassword
   */
  password: string;
  receivers: any[];
  recvBuffer: any;
  peer: any;
  isIdle: boolean;
  data: any;
  peerConfig: any;

  constructor (serverURL: string, task: Task, password: string) {
    /**
     * Note: We need append https and deai to the serverUrl here, since we
     * need to pass the "naked" version in the peerConfig parameter. This is
     * only necessary for production.
     */
    const deaiServerUrl = process.env.NODE_ENV === 'development'
      ? serverURL
      : 'https://'.concat(serverURL).concat('/deai/')

    super(deaiServerUrl, task)

    this.initPeerConfig(serverURL, task)

    this.password = password

    this.receivers = []
    this.recvBuffer = null
    this.peer = null
    this.isIdle = false
  }

  /**
   * Init config of peer js server based on build mode
   * @param serverURL
   * @param task
   */
  initPeerConfig (serverURL: string, task: Task) {
    this.peerConfig =
      process.env.NODE_ENV === 'development'
        ? {
            host: 'localhost',
            port: 8080,
            path: `/deai/${task.taskID}`
          }
        : {
            host: serverURL,
            path: `/deai/${task.taskID}`,
            secure: true,
            config: {
              iceServers: [
                { url: 'stun:stun.l.google.com:19302' },
                {
                  url: 'turn:34.77.172.69:3478',
                  credential: 'deai',
                  username: 'deai'
                }
              ]
            }
          }
  }

  /**
   * Conditionally import peerjs since it requires a window to work, which is not the case
   * for testing, this is a good reason to move to simple-peer.
   * @returns
   */
  __importPeer () {
    return typeof navigator !== 'undefined' ? require('peerjs').default : undefined
  }

  /**
   * Initialize the connection to the PeerJS server.
   * @param {Number} epochs the number of epochs.
   */
  async connect (epochs: number) {
    /*
     * If the server was just started (either due to having been idle, and then called, or running for the first time),
     * it is necessary to "wake it up" before making the first connection, otherwise the first connection will be ignored.
     * This is related to issue 196: https://github.com/epfml/DeAI/issues/196
     */
    const peerJsServerInfo = await fetch(
      this.serverURL.concat(`${this.task.taskID}`)
    ).then((response) => response.json())
    console.log('Connecting to', peerJsServerInfo)

    this.recvBuffer = {
      trainInfo: {
        epochs: epochs
      }
    }

    const Peer = this.__importPeer()

    this.peer = new Peer(makeID(10), this.peerConfig as any)

    return new Promise((resolve, reject) => {
      this.peer.on('error', (error) => {
        console.log('Failed to connect to the centralized server')
        console.log(error)
        resolve(false as any)
      })

      this.peer.on('open', async (id) => {
        console.log('Connected to the centralized server')
        this.peer.on('connection', (conn) => {
          console.log(`New connection from peer with ID ${conn.peer}`)
          conn.on('data', async (data) => {
            this.data = data
            await this._handleData(data, conn.peer)
          })
        })
        resolve(true as any)
      })
    })
  }

  /**
   * Disconnection process when user quits the task.
   */
  async disconnect () {
    if (this.peer != null) {
      this.peer.disconnect()
      this.peer.destroy()
    }
  }

  async onRoundEndCommunication (model, epoch: number, trainingInformant: TrainingInformant) {
    this.updateReceivers()
    const serializedWeights = await serializeWeights(model.weights)
    // TODO: Should send the current epoch
    const epochWeights = { epoch: epoch, weights: serializedWeights }

    const threshold = this.task.trainingInformation.threshold ?? 1
    /**
     * Iterate over all other peers connected to the same task and send them a
     * weights request.
     */
    for (const receiver of this.receivers) {
      await this._sendData(
        { name: this.peer.id },
        CMD_CODES.WEIGHT_REQUEST,
        receiver
      )
      trainingInformant.addMessage(`Sending weight request to: ${receiver}`)

      if (
        this.recvBuffer.weightRequests !== undefined &&
        this.recvBuffer.weightRequests.has(receiver)
      ) {
        console.log('Sending weights to: ', receiver)
        trainingInformant.addMessage(`Sending weights to: ${receiver}`)
        trainingInformant.updateWhoReceivedMyModel(receiver)
        await this._sendData(epochWeights, CMD_CODES.AVG_WEIGHTS, receiver)
      }
    }
    if (this.recvBuffer.weightRequests !== undefined) {
      trainingInformant.updateNbrWeightsRequests(
        this.recvBuffer.weightRequests.size
      )
      this.recvBuffer.weightRequests.clear()
    }

    // wait to receive weights only if other peers are connected (i.e I have receivers for now, might need to be updates)
    // For now, no distinction between receivers and being connected to the server
    if (this.receivers.length > 0) {
      // Wait to receive weights
      if (this.recvBuffer.avgWeights === undefined) {
        console.log('Waiting to receive weights...')
        trainingInformant.addMessage('Waiting to receive weights...')
        const startTime = new Date()
        await checkBufferUntil(
          this.recvBuffer,
          'avgWeights',
          MAX_TRIES,
          TIME_PER_TRIES
        )
        const endTime = new Date()
        const timeDiff =
          (endTime.getMilliseconds() - startTime.getMilliseconds()) / 1000
        trainingInformant.updateWaitingTime(Math.round(timeDiff))
        // Timeout to avoid deadlock (10s) TODO: where is the timeout?
      }

      if (this.recvBuffer.avgWeights !== undefined) {
        // Check if any weights were received
        console.log('Waiting to receive enough weights...')
        await checkBufferWeightsUntil(
          this.recvBuffer,
          threshold,
          MAX_TRIES,
          TIME_PER_TRIES
        )
        console.log('Averaging weights')
        trainingInformant.updateNbrUpdatesWithOthers(1)
        trainingInformant.addMessage('Averaging weights')

        // TODO: check whether to use averageWeights or assignWeightsToModel
        assignWeightsToModel(
          Object.values(this.recvBuffer.avgWeights).flat(1),
          model
        )

        delete this.recvBuffer.avgWeights // NOTE: this might delete useful weights...
      }
    } else {
      trainingInformant.addMessage(
        'No one is connected. Move to next epoch without waiting.'
      )
    }
  }

  async onTrainEndCommunication (model, trainingInformant: TrainingInformant) {
    trainingInformant.addMessage(
      'Entering idle state: seeding for online peers.'
    )
    this.recvBuffer.peer = this
    this.recvBuffer.lastUpdate = {
      epoch: this.task.trainingInformation.epochs,
      weights: await serializeWeights(model.weights)
    }
    /**
     * Enter into idle state. Incoming weight requests will be processed.
     * However, the peer will not emit any additional weight requests itself.
     * Within a P2P network, this acts like a seeding state w.r.t. the weights.
     */
    this.isIdle = true
    trainingInformant.addMessage('Training finished.')
  }

  /**
   * Updates the receivers' list.
   */
  async updateReceivers () {
    const peerIDs = await fetch(
      this.serverURL.concat(`${this.task.taskID}/peerjs/peers`)
    ).then((response) => response.json())

    this.receivers = peerIDs.filter((value) => value !== this.peer.id)
  }

  /**
   * Send data to a remote peer registered on the PeerJS server
   * @param {Object} data Data to send.
   * @param {Number} code Communication code.
   * @param {String} receiver Name of the receiver peer.
   */
  async _sendData (data, code, receiver) {
    const message = {
      cmdCode: code,
      payload: msgpack.encode(data)
    }
    if (this.password) {
      const SHA256 = new Hashes.SHA256()
      console.log(`Current peer: ${this.peer.id}`)
      data.password_hash = SHA256.hex(this.peer.id + ' ' + this.password)
    }
    const conn = this.peer.connect(receiver)
    conn.on('open', () => {
      conn.send(message)
    })
  }

  /**
   * Function given to PeerJS instance to handle incoming data
   * @param {object} data incoming data
   * @param {object} buffer buffer to store data
   */
  async _handleData (data, senderID) {
    console.log(`Received new data: ${data}`)

    if (!authenticate(data.password_hash, senderID, this.password)) {
      return
    }

    if (this.isIdle) {
      this._idleState(data)
      return
    }

    // Convert the peerjs ArrayBuffer back into Uint8Array
    const payload = msgpack.decode(Uint8Array.from(data.payload))
    const epoch = payload.epoch
    const weights = payload.weights
    const receiver = payload.name

    switch (data.cmdCode) {
      case CMD_CODES.MODEL_INFO:
        this.recvBuffer.model = payload
        break
      case CMD_CODES.ASSIGN_WEIGHTS:
        this.recvBuffer.assignWeights = payload
        break
      case CMD_CODES.COMPILE_MODEL:
        this.recvBuffer.compileData = payload
        break
      case CMD_CODES.AVG_WEIGHTS:
        console.log(payload)
        if (this.recvBuffer.avgWeights === undefined) {
          this.recvBuffer.avgWeights = {}
        }
        if (this.recvBuffer.avgWeights[epoch] === undefined) {
          this.recvBuffer.avgWeights[epoch] = [weights]
        } else {
          this.recvBuffer.avgWeights[epoch].push(weights)
        }
        console.log(`'#Weights: ${this.recvBuffer.avgWeights[epoch].length}`)
        break
      case CMD_CODES.TRAIN_INFO:
        this.recvBuffer.trainInfo = payload
        break
      case CMD_CODES.WEIGHT_REQUEST:
        if (this.recvBuffer.weightRequests === undefined) {
          this.recvBuffer.weightRequests = new Set([])
        }
        this.recvBuffer.weightRequests.add(receiver)
        console.log(`Weight request from: ${receiver}`)

        break
    }
  }

  async _idleState (data) {
    // convert the peerjs ArrayBuffer back into Uint8Array
    const epochWeights = {
      epoch: this.recvBuffer.lastUpdate.epoch,
      weights: this.recvBuffer.lastUpdate.weights
    }
    switch (data.cmdCode) {
      case CMD_CODES.WEIGHT_REQUEST:
        console.log(`Sending weights to: ${this.recvBuffer.peer}`)
        await this._sendData(
          epochWeights,
          CMD_CODES.AVG_WEIGHTS,
          this.recvBuffer.peer
        )
        break
    }
  }
}
