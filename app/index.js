import { Accelerometer } from "accelerometer"
import { HeartRateSensor } from "heart-rate"
import { me } from "appbit"
import { display } from "display"
import document from 'document'
import { inbox, outbox } from 'file-transfer'
import * as fs from "fs"
import { goals } from "user-activity"
import { ACCEL_SCALAR, valuesPerRecord, statusMsg, headerLength } from '../common/common.js'

const frequency = 16                                    // Hz (records per second): watch may go faster as it rounds intervals down to a multiple of 10ms
const simSamplePeriod = 10 * Math.floor(1000 / frequency / 10)  // ms
const batchPeriod = 1                      // elapsed time between batches (seconds) default: 1
const recordsPerBatch = frequency * batchPeriod
const bytesPerRecord = valuesPerRecord * 2              // 2 because values are Int16 (2 bytes) each
const recDurationPerFile = 10                           // seconds of data that will be stored in each file (assuming frequency is accurate) (default: 60)  // TODO 8 set recDurationPerFile = 60
const recordsPerFile = frequency * recDurationPerFile   // 1800 for ~15 second BT transfer time at 8 bytes per record; 100 for a new file every few seconds; file may exceed this by up to recordsPerBatch
const bytesPerBatch = bytesPerRecord * recordsPerBatch
const headerBuffer = new ArrayBuffer(headerLength)   // holds timestamp of first record in file
const headerBufferView = new Uint32Array(headerBuffer)
const dataBuffer = new ArrayBuffer(bytesPerBatch)
const dataBufferView = new Int16Array(dataBuffer)
const accel = new Accelerometer({ frequency: frequency, batch: recordsPerBatch })
const hrm = new HeartRateSensor({ frequency: 1, batch: batchPeriod })
//const touchEl = document.getElementById('touch')
const recTimeEl = document.getElementById('recTime')
const statusEl = document.getElementById('status')
const errorEl = document.getElementById('error')
const recBtnEl = document.getElementById('recBtn')
const xferBtnEl = document.getElementById('xferBtn')
const isSim = goals.calories === 360  // !!
const disableTouch = true             // ignore on-screen buttons while recording (useful for swim)

let fileDescriptor
let simAccelTimer
let simTimestamp
let simAccelReading
let isRecording = false, isTransferring = false
let fileNumberSending
let recordsInFile, recordsRecorded
let startTime
let dateLastBatch   // only used for debug logging
let fileTimestamp   // timestamp of first record in file currently being recorded
let prevTimestamp
let state = {
    fileNumberRecording: undefined
}

const fileTransferInterval = 10* 1000; // 10 seconds in milliseconds
let fileNumber = 1;

recBtnEl.text = 'START RECORDING'
start()
// recBtnEl.addEventListener("click", start)
me.appTimeoutEnabled = false

//*********************************************************************************** User input *****

function start() {
    recordData(); // Start recording data from sensors
    setTimeout(startPeriodicSend, fileTransferInterval); // Start sending files periodically after a 10-second delay
}

//********************************************************************************** Record data *****

function deleteFiles() {
    const fileIter = fs.listDirSync('/private/data')
    let nextFile = fileIter.next()
    while (!nextFile.done) {
        fs.unlinkSync(nextFile.value)
        nextFile = fileIter.next()
    }
}

function recordData() {
    accel.addEventListener("reading", onAccelReading)
    startRec()
}

function startPeriodicSend() {
    setInterval(() => {
        if (!isTransferring) {
            sendFile(fileNumber);
            fileNumber++;
        }
    }, fileTransferInterval);
}

function startRec() {
    if (isTransferring) return

    deleteFiles()

    dateLastBatch = simAccelReading = recordsInFile = recordsRecorded = 0
    simTimestamp = 4000000000
    recTimeEl.text = '0'
    state.fileNumberRecording = 1
    //fileDescriptor = fs.openSync(state.fileNumberRecording, 'a')
    errorEl.style.fill = '#ff0000'
    errorEl.text = ''
    statusEl.text = 'Recording file ' + state.fileNumberRecording
    accel.start()
    hrm.start()
    if (simAccelTimer) { clearTimeout(simAccelTimer); simAccelTimer = 0 }
    console.log('Started.')
    recBtnEl.text = disableTouch ? '← PRESS KEY TO STOP' : 'STOP RECORDING'
    recBtnEl.state = 'disabled'
    recBtnEl.style.display = 'inline'
    xferBtnEl.style.display = 'none'  // xferBtnEl.text = ''
    startTime = Date.now()
    if (isSim) simAccelTimer = setInterval(simAccelTick, batchPeriod * 1000)
    isRecording = true
}

function sendFile(fileName) {

    const operation = fileName ? 'Res' : 'S'   // plus 'ending...'
    if (!fileName) fileName = fileNumberSending

    outbox
        .enqueueFile("/private/data/" + fileName)
        .then(ft => {
            console.log(`${operation}ending file ${fileName} of ${state.fileNumberRecording}: queued`);
        })
        .catch(err => {
            console.error(`Failed to queue transfer of ${fileName}: ${err}`);
        })
}

function simAccelTick() {  // fake data - used when running in Fitbit Simulator to simulate accel readings
    if (!isRecording) {
        console.error("simAccelTick but not recording")
        return
    }

    // See if we need a new file for this batch:
    const needNewFile = fileDescriptor === undefined || recordsInFile >= recordsPerFile
    if (needNewFile) {
        fileTimestamp = prevTimestamp = simTimestamp
        console.log(`needNewFile: fileTimestamp=${fileTimestamp}`);
    }

    // Put the accel readings into dataBuffer:
    const batchSize = recordsPerBatch // Accel: freqeuncy * batchPeriod, hrm: 1 * batchPeriod
    let bufferIndex = 0, timestamp
    console.log(`Cooking a batch; fileTimestamp=${fileTimestamp}`);
    for (let index = 0; index < batchSize; index++) {
        dataBufferView[bufferIndex++] = (simAccelReading++) & 0xFFFF
        dataBufferView[bufferIndex++] = (simAccelReading++) & 0xFFFF
        dataBufferView[bufferIndex++] = (simAccelReading++) & 0xFFFF
        dataBufferView[bufferIndex++] = (simAccelReading++) & 0xFFFF
    }
    
    // Open a new file if necessary:
    if (fileDescriptor === undefined) {   // this is the start of this recording session
        openFile()
    } else {  // a file is already open
        if (recordsInFile >= recordsPerFile) {  // file is full
            fs.closeSync(fileDescriptor)
            recordsRecorded += recordsInFile
            state.fileNumberRecording++
            openFile()
        }
    }

    // Write record batch to file:
    try {
        fs.writeSync(fileDescriptor, dataBuffer, 0, batchSize * bytesPerRecord)
        recordsInFile += batchSize
    } catch (e) {
        console.error("Can't write to file")
    }
    recTimeEl.text = Math.round((Date.now() - startTime) / 1000)
}

function openFile() {   // opens a new file corresponding to state.fileNumberRecording and writes fileTimestamp
    console.log(`Starting new file: ${state.fileNumberRecording}`)
    fileDescriptor = fs.openSync(state.fileNumberRecording, 'a')
    // Write fileTimestamp at start of file:
    headerBufferView[0] = fileTimestamp
    //console.log(`header=${headerBufferView[0]}`)
    fs.writeSync(fileDescriptor, headerBuffer)
    
    recordsInFile = 0
    statusEl.text = 'Recording file ' + state.fileNumberRecording
}

function onAccelReading() {
    if (!isRecording) {
        console.error("onAccelReading but not recording")
        return
    }

    const dateNow = Date.now()
    if (dateLastBatch) {
        //console.log(`t since last batch: ${dateNow-dateLastBatch} ms`)  // debugging
    }
    dateLastBatch = dateNow

    // See if we need a new file for this batch:
    const needNewFile = fileDescriptor === undefined || recordsInFile >= recordsPerFile
    if (needNewFile) {
        fileTimestamp = prevTimestamp = accel.readings.timestamp[0]
        console.log(`needNewFile: fileTimestamp=${fileTimestamp}`);
    }

    // Put the accel readings into dataBuffer:
    const batchSize = accel.readings.timestamp.length // Accel: freqeuncy * batchPeriod, hrm: 1 * batchPeriod
    let bufferIndex = 0, timestamp
    for (let index = 0; index < batchSize; index++) {
        dataBufferView[bufferIndex++] = hrm.readings.heartRate[(index % batchPeriod)]
        dataBufferView[bufferIndex++] = accel.readings.x[index] * ACCEL_SCALAR
        dataBufferView[bufferIndex++] = accel.readings.y[index] * ACCEL_SCALAR
        dataBufferView[bufferIndex++] = accel.readings.z[index] * ACCEL_SCALAR
    }

    // Open a new file if necessary:
    if (fileDescriptor === undefined) {   // this is the start of this recording session
        openFile()
    } else {  // a file is already open
        if (recordsInFile >= recordsPerFile) {  // file is full
            fs.closeSync(fileDescriptor)
            recordsRecorded += recordsInFile
            state.fileNumberRecording++
            openFile()
        }
    }

    // Write record batch to file:
    try {
        fs.writeSync(fileDescriptor, dataBuffer, 0, batchSize * bytesPerRecord)
        recordsInFile += batchSize
    } catch (e) {
        console.error("Can't write to file (out of storage space?)")
    }

    /*if ((recordsInFile += batchSize) >= recordsPerFile) {
      console.log(`Closing file ${state.fileNumberRecording} (${recordsInFile} records)`)
      fs.closeSync(fileDescriptor)
      fileDescriptor = fs.openSync(++state.fileNumberRecording, 'a')
      recordsInFile = 0
      statusEl.text = 'Recording file ' + state.fileNumberRecording
      //console.log('Started new file')
    }*/

    recTimeEl.text = Math.round((Date.now() - startTime) / 1000)
}

//********************************************************************************** Transfer data *****

me.onunload = () => {
    saveState()
}

function saveState() {
    fs.writeFileSync("state.cbor", state, "cbor")
}