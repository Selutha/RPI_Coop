const svr = require('fastify')({ logger: false })
const path = require('path')
// Set up the HTTP server
svr.register(require('@fastify/static'), { root: path.join(__dirname, 'public') })
// Bring in socket.io
svr.register(require('fastify-socket.io'))
const bme280 = require('bme280')
const { Gpio } = require('onoff') // Include onoff to interact with the GPIO
const fs = require('fs')
const configFile = './configSettings.json'
const objConfig = require('./configSettings.json')
// Enable, output, initially high so all gpio are OFF when starting this app
const gpioHeat = new Gpio(529, 'low')
const gpioExhaust = new Gpio(539, 'low')
const gpioLight = new Gpio(534, 'low')
const gpioDoor = new Gpio(535, 'low')

// gpio for the chicken coop door 518 and 525
// open is 518 high and 525 low
// close is 518 low and 525 high
// lets set this to be closed by default
const gpioCoopDoor1 = new Gpio(518, 'low')
const gpioCoopDoor2 = new Gpio(525, 'high')

// gpio for the chicken run is 531 and 538
// To open the chicken run door both pins must be set, 531 high and 538 low
// To close the chicken run door both pins must be set, 531 is low while 538 is high
// lets set this to be closed by default
const gpioRunDoor1 = new Gpio(531, 'low')
const gpioRunDoor2 = new Gpio(538, 'high')




// set to be on when gpio input circuit is closed (i.e photocell relay is closed)
const gpioPhoto = new Gpio(537, 'in', 'both', { debounceTimeout: 10, activeLow: false })
const off = 0
const on = 1
// These variables are modified in various functions
let clientCnt = 0
let current24hTime
let countDown = false
let msPhotocellStartTime
let msPhotocellEndTime

// Functions

const currentTime = () => {
  // Get the current time and format to hh:mm
  const currentDateTime = new Date(Date.now())
  return currentDateTime.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })
}

function updateConfigFile () {
  console.log(`Writing changes to config file: ${configFile}`)
  fs.writeFile(configFile, JSON.stringify(objConfig, null, 4), (err) => {
    if (err) console.log('Error writing config file:', err)
  })
}

// This will provide index.html when a client connects
svr.get('/', function (req, reply) {
  console.log('Sending index.html')
  reply.sendFile('index.html')
})

function gpioStatus (gpioItem, gpioType) {
  if (gpioItem.readSync() === on) {
    if (gpioType === 'OpenClose') {
      return 'OPEN'
    } else {
      return 'ON'
    }
  } else {
    if (gpioType === 'OpenClose') {
      return 'CLOSED'
    } else {
      return 'OFF'
    }
  }
}

// This function will open the run door
function openDoor (gpioMotorPin1, gpioMotorPin2) {
  gpioMotorPin1.writeSync(on)
  gpioMotorPin2.writeSync(off)
}

// this function will close the run door
function closeDoor (gpioMotorPin1, gpioMotorPin2) {
  gpioMotorPin1.writeSync(off)
  gpioMotorPin2.writeSync(on)
}

// Get the current state of the coop or the run door by reading the output of both pins
function getDoorState (gpio1, gpio2) {
  if (gpio1.readSync() === on && gpio2.readSync() === off) {
    return 'OPEN'
  } else {
    return 'CLOSED'
  }
}

function getPhotocellEndTime () {
  let hours = 0
  switch (objConfig._lightDurationIdx) {
    case 0:
      hours = 0
      break
    case 1:
      hours = msPhotocellStartTime + (14 * 3600000)
      break
    case 2:
      hours = msPhotocellStartTime + (15 * 3600000)
      break
    case 3:
      hours = msPhotocellStartTime + (16 * 3600000)
      break
    default:
      hours = 0
  }
  return hours
}

function refreshPageData () {
  // Send status to client only if there is a client connected.
  if (clientCnt > 0) {
    // Let's update the current time
    objConfig._svrTime = currentTime()
    // Monitor the gpio status
    objConfig._heatRelayTxt = gpioStatus(gpioHeat, 'OnOff')
    objConfig._exhaustRelayTxt = gpioStatus(gpioExhaust, 'OnOff')
    objConfig._coopDoorRelayTxt = getDoorState(gpioCoopDoor1, gpioCoopDoor2)
    objConfig._runDoorRelayTxt = getDoorState(gpioRunDoor1, gpioRunDoor2)
    objConfig._lightRelayTxt = gpioStatus(gpioLight, 'OnOff')
    objConfig._photocellTxt = gpioStatus(gpioPhoto, 'OnOff')
    // push the data to the html page
    svr.io.sockets.emit('refreshPageData', objConfig)
  }
}

async function heatController () {
  // console.log(`_heatMode: ${objConfig._heatMode} -- _heatRelayTxt: ${objConfig._heatRelayTxt}  -- gpioHeat.readSync(): ${gpioHeat.readSync()}`)
  // Only run if mode = Auto
  if (objConfig._heatMode === 'Auto') {
    if (objConfig._degF < objConfig._heatSetPnt) {
      // Console.log('Turning Relay ON');
      if (gpioHeat.readSync() === off) {
        gpioHeat.writeSync(on) // Turn relay on
      }
      objConfig._heatRelayTxt = 'ON'
    }

    if (objConfig._degF > (objConfig._heatSetPnt + 1)) {
      // Console.log('Turning Relay OFF');
      if (gpioHeat.readSync() === on) {
        gpioHeat.writeSync(off) // Turn relay off
      }
      objConfig._heatRelayTxt = 'OFF'
    }
  } else {
    // Only run if mode = Manual
    if (objConfig._heatRelayTxt === 'ON') {
      if (gpioHeat.readSync() === off) {
        gpioHeat.writeSync(on) // Turn relay on
      }
    } else {
      if (gpioHeat.readSync() === on) {
        gpioHeat.writeSync(off) // Turn relay off
      }
    }
  }
  // console.log(`HEAT -- DegF: ${objConfig._degF} -- SetPnt: ${objConfig._heatSetPnt} -- Mode: ${objConfig._heatMode} -- Relay: ${objConfig._heatRelayTxt} -- Gpio: ${gpioHeat.readSync()}`)
}

async function exhaustController () {
  // Only run if mode = Auto
  if (objConfig._exhaustMode === 'Auto') {
    if (objConfig._degF > objConfig._exhaustSetPnt) {
      // Console.log('Turning Relay ON');
      if (gpioExhaust.readSync() === off) {
        gpioExhaust.writeSync(on) // Turn relay on
      }
      objConfig._exhaustRelayTxt = 'ON'
    }

    if (objConfig._degF < (objConfig._exhaustSetPnt - 1)) {
      // Console.log('Turning Relay OFF');
      if (gpioExhaust.readSync() === on) {
        gpioExhaust.writeSync(off) // Turn relay off
      }
      objConfig._exhaustRelayTxt = 'OFF'
    }
  } else {
    if (objConfig._exhaustRelayTxt === 'ON') {
      if (gpioExhaust.readSync() === off) {
        gpioExhaust.writeSync(on) // Turn relay on
      }
    } else {
      if (gpioExhaust.readSync() === on) {
        gpioExhaust.writeSync(off) // Turn relay off
      }
    }
  }
  // console.log(`EXHAUST -- DegF: ${objConfig._degF} -- SetPnt: ${objConfig._exhaustSetPnt} -- Mode: ${objConfig._exhaustMode} -- Relay: ${objConfig._exhaustRelayTxt} -- Gpio: ${gpioExhaust.readSync()}`)
}

async function coopDoorController () {
  // Only run if mode = Auto
  const currentDoorState = getDoorState(gpioCoopDoor1, gpioCoopDoor2);

  if (objConfig._coopDoorMode === 'Auto') {
    current24hTime = currentTime()

    // Check if photo relay is on
    if (gpioPhoto.readSync() === on) {
      if (current24hTime >= objConfig._coopDoorDelayTime) {
        // Now we can open the door
        // If relay is off lets turn it on
        if (currentDoorState === 'CLOSED') {
          openDoor(gpioCoopDoor1, gpioCoopDoor2)
          // console.log(`Open Door - ${current24hTime} is >= to ${doorDelayTime}`)
        }
        objConfig._coopDoorRelayTxt = 'OPEN'
      } else {
        // Photocell is off. Now we can close the door
        // If relay is on lets turn it off
        if (currentDoorState === 'OPEN') {
          closeDoor(gpioCoopDoor1, gpioCoopDoor2)
          // console.log(`Close Door - ${current24hTime} is < to ${doorDelayTime}`)
        }
        objConfig._coopDoorRelayTxt = 'CLOSED'
      }
    } else {
      // Photocell is off. Now we can close the door
      // If relay is on lets turn it off
      if (currentDoorState === 'OPEN') {
        closeDoor(gpioCoopDoor1, gpioCoopDoor2)
        // console.log(`Close Door - Photocell is off`)
      }
      objConfig._coopDoorRelayTxt = 'CLOSED'
    }
  } else {
    if (objConfig._coopDoorRelayTxt === 'OPEN') {
      if (getDoorState(gpioCoopDoor1, gpioCoopDoor2) === 'CLOSED') {
        openDoor(gpioCoopDoor1, gpioCoopDoor2)
      }
    } else {
      if (getDoorState(gpioCoopDoor1, gpioCoopDoor2) === 'OPEN') {
        closeDoor(gpioCoopDoor1, gpioCoopDoor2)     
      }
    }
  }
}

async function runDoorController () {
  // Only run if mode = Auto
  const currentDoorState = getDoorState(gpioRunDoor1, gpioRunDoor2);

  if (objConfig._runDoorMode === 'Auto') {
    current24hTime = currentTime()

    // Check if photo relay is on
    if (gpioPhoto.readSync() === on) {
      if (current24hTime >= objConfig._runDoorDelayTime) {
        // Now we can open the door
        // If relay is off lets turn it on
        if (currentDoorState === 'CLOSED') {
          openDoor(gpioRunDoor1, gpioRunDoor2)
          // console.log(`Open Door - ${current24hTime} is >= to ${doorDelayTime}`)
        }
        objConfig._runDoorRelayTxt = 'OPEN'
      } else {
        // Photocell is off. Now we can close the door
        // If relay is on lets turn it off
        if (currentDoorState === 'OPEN') {
          closeDoor(gpioRunDoor1, gpioRunDoor2)
          // console.log(`Close Door - ${current24hTime} is < to ${doorDelayTime}`)
        }
        objConfig._runDoorRelayTxt = 'CLOSED'
      }
    } else {
      // Photocell is off. Now we can close the door
      // If relay is on lets turn it off
      if (currentDoorState === 'OPEN') {
        closeDoor(gpioRunDoor1, gpioRunDoor2)
        // console.log(`Close Door - Photocell is off`)
      }
      objConfig._runDoorRelayTxt = 'CLOSED'
    }
  } else {
    if (objConfig._runDoorRelayTxt === 'OPEN') {
      if (getDoorState(gpioRunDoor1, gpioRunDoor2) === 'CLOSED') {
        openDoor(gpioRunDoor1, gpioRunDoor2)
      }
    } else {
      if (getDoorState(gpioRunDoor1, gpioRunDoor2) === 'OPEN') {
        closeDoor(gpioRunDoor1, gpioRunDoor2)     
      }
    }
  }
  // console.log(`DOOR -- Photocell: ${objConfig._PhotocellTxt} -- Del Time: ${objConfig._doorDelayTime} -- Cur Time: ${objConfig._svrTime} -- Door is: ${objConfig._doorRelayTxt} -- Gpio: ${gpioDoor.readSync()}`)
}

async function lightController () {
  // Lets start the countdown at sunrise if countDown === false
  if (gpioPhoto.readSync() === on && countDown === false) {
    countDown = true // Let's enable the flag
    // Lets store the current time
    msPhotocellStartTime = Date.now() // milliseconds
  }

  // _lightDurationIdx is 'DISABLED' we don't want any suplimental lighting.
  if (objConfig._lightDurationIdx === 0) { countDown = false }

  // Only run if mode = auto
  if (objConfig._lightMode === 'Auto' && countDown === true) {
    if (Date.now() < getPhotocellEndTime()) {
      if (gpioLight.readSync() === off) {
        gpioLight.writeSync(on) // Turn relay on
      }
      objConfig._lightRelayTxt = 'ON'
    } else {
      if (gpioLight.readSync() === on) {
        gpioLight.writeSync(off) // Turn relay off
      }
      countDown = false
      objConfig._lightRelayTxt = 'OFF'
    }
  } else {
    if (objConfig._lightRelayTxt === 'ON') {
      if (gpioLight.readSync() === off) {
        gpioLight.writeSync(on) // Turn relay on
      }
    } else {
      if (gpioLight.readSync() === on) {
        gpioLight.writeSync(off) // Turn relay off
      }
    }
  }
}

const runApplication = async _ => {
  const format = number => (Math.round(number * 100) / 100).toFixed(2)
  const delay = millis => new Promise(resolve => setTimeout(resolve, millis))

// Mock bme280 object
//const bme280 = {
//  OVERSAMPLE: {
//    X1: 1,
//    X16: 16,
//    X2: 2,
//  },
//  FILTER: {
//    F16: 16,
//  },
//  async open(config) {
//   console.log("Mock BME280 sensor initialized with config:", config);
    
    // Return a mock sensor object
//    return {
//      async read() {
        // Simulate returning constant sensor data
//        return {
//          temperature: 22.5,  // Mock temperature in °C
//          pressure: 1013.25,  // Mock pressure in hPa
//          humidity: 45.0,     // Mock humidity in %
//        };
//      },
//      async close() {
//        console.log("Mock BME280 sensor closed");
//      }
//    };
//  }
//};
	
  while (true) {
    try {
      const sensor = await bme280.open({
        i2cBusNumber: 1,
        i2cAddress: 0x76,
        humidityOversampling: bme280.OVERSAMPLE.X1,
        pressureOversampling: bme280.OVERSAMPLE.X16,
        temperatureOversampling: bme280.OVERSAMPLE.X2,
        filterCoefficient: bme280.FILTER.F16
      })

      const reading = await sensor.read()
      objConfig._degC = format(reading.temperature)
      objConfig._degF = format((objConfig._degC * 1.8) + 32)
      objConfig._pctRH = format(reading.humidity)
      objConfig._inHg = format(reading.pressure * 0.02953)

      await sensor.close()
    } catch (err) {
      console.log('BME280 sensor read failed, using last known values:', err.message)
    }

    await delay(2000) // 1000 = 1 second
    await heatController()
    await exhaustController()
    await coopDoorController()
    await runDoorController()
    await lightController()
    refreshPageData()
  }
}

// we need to wait for the server to be ready, else `server.io` is undefined
svr.ready().then(() => {
  console.log('Server is ready!')

  // Whenever someone connects, this piece of code is executed
  svr.io.on('connection', (socket) => {
    clientCnt = svr.io.engine.clientsCount
    console.log(`Client count is ${clientCnt.toString()} -- Connected id: ${socket.id.toString()}`)

    // ##############################################################
    // client is connected so now we wait for socket emit from client
    // ##############################################################

    // #region Heat Control
    socket.on('heatSetPnt', (data) => {
      objConfig._heatSetPnt = data.toString()
    })

    socket.on('heatRelay', data => {
      objConfig._heatRelayTxt = data
    })

    socket.on('heatMode', data => {
      objConfig._heatMode = data
    })
    // #endregion

    // #region Exhaust Control
    socket.on('exhaustSetPnt', (data) => {
      objConfig._exhaustSetPnt = data.toString()
    })

    socket.on('exhaustRelay', data => {
      objConfig._exhaustRelayTxt = data
    })

    socket.on('exhaustMode', data => {
      objConfig._exhaustMode = data
    })
    // #endregion

    // #region coop Door Control
    socket.on('coopDoorDelayTime', data => {
      objConfig._coopDoorDelayTime = data
    })

    socket.on('coopDoorRelay', data => {
      objConfig._coopDoorRelayTxt = data
    })

    socket.on('coopDoorMode', data => {
      objConfig._coopDoorMode = data
    })
    // #endregion

    // #region Run Door Control
    socket.on('runDoorDelayTime', data => {
      objConfig._runDoorDelayTime = data
    })

    socket.on('runDoorRelay', data => {
      objConfig._runDoorRelayTxt = data
    })

    socket.on('runDoorMode', data => {
      objConfig._runDoorMode = data
    })
    // #endregion

    // #region Light Control
    socket.on('lightDurationIdx', data => {
      objConfig._lightDurationIdx = data
    })

    socket.on('lightRelay', data => {
      objConfig._lightRelayTxt = data
    })

    socket.on('lightMode', data => {
      objConfig._lightMode = data
    })
    // #endregion

    // Whenever someone disconnects, this piece of code is executed
    socket.on('disconnect', () => {
      clientCnt = svr.io.engine.clientsCount
      updateConfigFile()
      console.log(`Client count is ${clientCnt.toString()} -- Disconnected id: ${socket.id.toString()}`)
    })
  })
  // ################################
  // now we can run the control logic
  // ################################
  runApplication()
})

// Run the server!
svr.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.log(err); throw err }
  console.log(`Server is now listening on ${address}`)
})
