import { expect } from 'chai'
import * as api from '../src/helpers/communication/federated/api'

const task = 'titanic'
const user = 'a'
// const nonValidTask = 'nonValidTask'
const oldTimeStamp = -1

describe('API test', () => { // the tests container
  it('Connect to valid task', async () => {
    expect((await api.connect(task, user)).status).equal(200)
  })

  it('disconnect from valid task', async () => {
    expect((await api.disconnect(task, user)).status).equal(200)
  })

  // it('Connect to non valid task', async () => {
  //   console.log((await api.connect(nonValidTask, user)).status)
  //   expect((await api.connect(nonValidTask, user)).status).equal(404)
  // })

  it('getAreWeightsOutOfDate for old time stamp is true', async () => {
    expect((await api.getAreWeightsOutOfDate(task, user, oldTimeStamp)).status).true
  })
})
