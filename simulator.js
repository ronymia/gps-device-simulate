const net = require("net");
const readline = require("readline");
const https = require("https"); // Required for fetching Road Routes

// ==========================================
// CONFIGURATION
// ==========================================

const CONFIG = {
  // 1. SERVER DETAILS
  // HOST: "54.37.225.65",
  HOST: "127.0.0.1",
  PORT: 4017,

  // 2. SIMULATION SETTINGS
  NUM_DEVICES: 10, // Total number of virtual cars
  CENTER_LAT: 51.5074, // Center of simulation (London, UK)
  CENTER_LNG: -0.1278,
  TRIP_DISTANCE_KM: 5, // Average trip distance

  // 3. TIMING
  GPS_INTERVAL_MS: 1000 * 10, // Send GPS every 2 seconds
};

// ==========================================
// PROTOCOL CONSTANTS (JT/T 808)
// ==========================================
const MSG_ID = {
  REGISTER: 0x0100,
  AUTH: 0x0102,
  HEARTBEAT: 0x0002,
  LOCATION: 0x0200,
};

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

// Convert number to BCD Buffer (for IMEI and Time)
function intToBcd(num, len) {
  const bcd = Buffer.alloc(len);
  const str = num.toString().padStart(len * 2, "0");
  for (let i = 0; i < len; i++) {
    bcd[i] = parseInt(str.substr(i * 2, 2), 16);
  }
  return bcd;
}

// Calculate XOR Checksum
function calculateChecksum(buf) {
  let cs = 0;
  for (let i = 0; i < buf.length; i++) cs ^= buf[i];
  return cs;
}

// Escape reserved bytes (0x7E, 0x7D)
function escapeBuffer(buf) {
  let escaped = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7e) escaped.push(0x7d, 0x02);
    else if (buf[i] === 0x7d) escaped.push(0x7d, 0x01);
    else escaped.push(buf[i]);
  }
  return Buffer.from(escaped);
}

// Unescape incoming data
function unescapeBuffer(buf) {
  let unescaped = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7d) {
      i++;
      if (buf[i] === 0x02) unescaped.push(0x7e);
      else if (buf[i] === 0x01) unescaped.push(0x7d);
    } else {
      unescaped.push(buf[i]);
    }
  }
  return Buffer.from(unescaped);
}

// Generate a 12-digit device ID based on index
function generateIMEI(index) {
  return `868120${String(index).padStart(6, "0")}`;
}

// Helper to make HTTP requests (for OSRM)
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// ==========================================
// VIRTUAL DEVICE CLASS
// ==========================================
class VirtualDevice {
  constructor(index) {
    this.index = index;

    // Identity
    this.imei = generateIMEI(index);
    this.plateNumber = `SIM-${index.toString().padStart(4, "0")}`;

    // State
    this.serialNo = 1;
    this.authCode = "";
    this.socket = null;
    this.intervals = [];
    this.status = "OFFLINE";

    // Movement State
    this.lat = CONFIG.CENTER_LAT;
    this.lng = CONFIG.CENTER_LNG;

    // Road Navigation State
    this.route = []; // Array of [lng, lat] coordinates
    this.routeIndex = 0;
    this.speed = 0; // Calculated dynamically per route
    this.direction = 0;
  }

  connect() {
    if (this.socket) this.disconnect();

    this.socket = new net.Socket();
    this.status = "CONNECTING";

    this.socket.on("data", (data) => this.handleData(data));
    this.socket.on("close", () => {
      this.status = "OFFLINE";
      this.clearIntervals();
    });
    this.socket.on("error", (err) => {
      console.log(`[Device ${this.index}] Error: ${err.message}`);
      this.status = "ERROR";
      this.clearIntervals();
    });

    this.socket.connect(CONFIG.PORT, CONFIG.HOST, () => {
      this.status = "CONNECTED";
      console.log(`[Device ${this.index}] Connected.`);
      this.sendRegister();
    });
  }

  disconnect() {
    this.clearIntervals();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.status = "OFFLINE";
    console.log(`[Device ${this.index}] Stopped.`);
  }

  clearIntervals() {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
  }

  // Build a valid JT/T 808 Packet
  buildPacket(msgId, body) {
    const phone = intToBcd(this.imei, 6);
    const serial = Buffer.alloc(2);
    serial.writeUInt16BE(this.serialNo++);

    const msgProps = Buffer.alloc(2);
    msgProps.writeUInt16BE(body.length);

    const header = Buffer.concat([
      Buffer.from([msgId >> 8, msgId & 0xff]),
      msgProps,
      phone,
      serial,
    ]);

    const content = Buffer.concat([header, body]);
    const checksum = Buffer.from([calculateChecksum(content)]);
    const rawPacket = Buffer.concat([content, checksum]);

    // Escape the content (NOT the 0x7E markers)
    const escapedContent = escapeBuffer(rawPacket);

    // Wrap with 0x7E markers
    return Buffer.concat([
      Buffer.from([0x7e]),
      escapedContent,
      Buffer.from([0x7e]),
    ]);
  }

  sendPacket(msgId, body) {
    if (!this.socket || this.socket.destroyed) return;
    const packet = this.buildPacket(msgId, body);
    this.socket.write(packet);
  }

  sendRegister() {
    // Proper JT/T 808 registration body
    const manufacturer = Buffer.alloc(5);
    Buffer.from("SIMUL").copy(manufacturer);

    const model = Buffer.alloc(20);
    Buffer.from("MODEL01").copy(model);

    const terminalId = Buffer.alloc(7);
    Buffer.from(this.imei.slice(-7)).copy(terminalId);

    const body = Buffer.concat([
      Buffer.from([0x00, 0x00]), // Province ID
      Buffer.from([0x00, 0x00]), // City ID
      manufacturer, // Manufacturer (5 bytes)
      model, // Model (20 bytes)
      terminalId, // Terminal ID (7 bytes)
      Buffer.from([0x01]), // Plate Color (Blue)
      Buffer.from(this.plateNumber), // Plate String
    ]);
    this.sendPacket(MSG_ID.REGISTER, body);
  }

  sendAuth() {
    const body = Buffer.from(this.authCode);
    this.sendPacket(MSG_ID.AUTH, body);
  }

  async startStreaming() {
    console.log(
      `[Device ${this.index}] ✅ Authenticated. Finding first route...`,
    );

    // Heartbeat every 30 seconds
    this.intervals.push(
      setInterval(() => {
        this.sendPacket(MSG_ID.HEARTBEAT, Buffer.alloc(0));
      }, 30000),
    );

    // GPS Loop every GPS_INTERVAL_MS
    this.intervals.push(
      setInterval(() => {
        this.updatePosition();
        this.sendLocation();
      }, CONFIG.GPS_INTERVAL_MS),
    );

    // Get First Route
    await this.fetchNewRoute();
  }

  // --- ROAD LOGIC ---

  // Fetch a real road route from OSRM (Free Open Source Routing)
  async fetchNewRoute() {
    try {
      // Pick random start and end points roughly within London area
      const rLat = CONFIG.CENTER_LAT + (Math.random() - 0.5) * 0.1;
      const rLng = CONFIG.CENTER_LNG + (Math.random() - 0.5) * 0.1;

      // Use current position as start if available, else random
      const startLng = this.route.length > 0 ? this.lng : rLng;
      const startLat = this.route.length > 0 ? this.lat : rLat;

      const endLat = startLat + (Math.random() - 0.5) * 0.05; // Small random trip
      const endLng = startLng + (Math.random() - 0.5) * 0.05;

      // OSRM API: driving car
      const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;

      const data = await httpGet(url);

      if (data.code === "Ok" && data.routes && data.routes.length > 0) {
        this.route = data.routes[0].geometry.coordinates; // Array of [lng, lat]
        this.routeIndex = 0;
        this.speed = Math.floor(Math.random() * 30) + 20; // Random 20-50km/h

        // Snap device position to the first road-snapped waypoint of the new route.
        // Without this, the device walks in a straight line (across parks/buildings)
        // from its old position to the first road point.
        this.lng = this.route[0][0];
        this.lat = this.route[0][1];

        console.log(
          `[Device ${this.index}] New route found (${this.route.length} points). Speed: ${this.speed}km/h | Start: ${this.lat.toFixed(6)},${this.lng.toFixed(6)}`,
        );
      } else {
        console.log(
          `[Device ${this.index}] Failed to find route. Retrying in 5s...`,
        );
        setTimeout(() => this.fetchNewRoute(), 5000);
      }
    } catch (error) {
      console.log(`[Device ${this.index}] Routing API Error: ${error.message}`);
      setTimeout(() => this.fetchNewRoute(), 5000);
    }
  }

  updatePosition() {
    if (this.route.length === 0) return;

    if (this.routeIndex >= this.route.length) {
      // Route finished, get a new one
      this.fetchNewRoute();
      return;
    }

    // Calculate how far the vehicle should travel this tick based on real speed
    // speed is in km/h, GPS_INTERVAL_MS is in ms
    const tickSeconds = CONFIG.GPS_INTERVAL_MS / 1000;
    let remainingKm = (this.speed / 3600) * tickSeconds;

    // Walk through route waypoints, consuming distance until this tick's budget is spent
    while (remainingKm > 0 && this.routeIndex < this.route.length) {
      const target = this.route[this.routeIndex];
      const targetLng = target[0];
      const targetLat = target[1];

      const distLat = targetLat - this.lat;
      const distLng = targetLng - this.lng;

      // Convert lat/lng delta to approximate km using Haversine approximation
      const dLatKm = distLat * 111.32;
      const dLngKm = distLng * 111.32 * Math.cos((this.lat * Math.PI) / 180);
      const segmentKm = Math.sqrt(dLatKm * dLatKm + dLngKm * dLngKm);

      // Calculate heading toward this waypoint
      this.direction = (Math.atan2(distLng, distLat) * 180) / Math.PI;
      if (this.direction < 0) this.direction += 360;

      if (segmentKm <= remainingKm) {
        // Snap exactly to the waypoint and advance to the next
        this.lat = targetLat;
        this.lng = targetLng;
        remainingKm -= segmentKm;
        this.routeIndex++;
      } else {
        // Move partially along the segment proportional to remaining distance budget
        const fraction = remainingKm / segmentKm;
        this.lat += distLat * fraction;
        this.lng += distLng * fraction;
        remainingKm = 0;
      }
    }
  }

  sendLocation() {
    const alarm = Buffer.alloc(4);
    const status = Buffer.alloc(4);

    // Base status: bit0=ACC ON, bit1=Positioned
    let statusBits = 0b11;
    let latValue = this.lat;
    let lngValue = this.lng;

    // bit2: 0=North, 1=South
    if (latValue < 0) {
      statusBits |= 1 << 2;
      latValue = Math.abs(latValue);
    }
    // bit3: 0=East, 1=West
    if (lngValue < 0) {
      statusBits |= 1 << 3;
      lngValue = Math.abs(lngValue);
    }

    status.writeUInt32BE(statusBits);

    const latBuf = Buffer.alloc(4);
    latBuf.writeUInt32BE(Math.round(latValue * 1000000));
    const lngBuf = Buffer.alloc(4);
    lngBuf.writeUInt32BE(Math.round(lngValue * 1000000));

    const altitude = Buffer.from([0x00, 0x32]);
    const speedBuf = Buffer.alloc(2);
    speedBuf.writeUInt16BE(this.speed);
    const dirBuf = Buffer.alloc(2);
    dirBuf.writeUInt16BE(Math.round(this.direction));

    const time = new Date();
    const timeStr =
      time.getFullYear().toString().slice(2) +
      (time.getMonth() + 1).toString().padStart(2, "0") +
      time.getDate().toString().padStart(2, "0") +
      time.getHours().toString().padStart(2, "0") +
      time.getMinutes().toString().padStart(2, "0") +
      time.getSeconds().toString().padStart(2, "0");
    const timeBcd = intToBcd(timeStr, 6);

    const body = Buffer.concat([
      alarm,
      status,
      latBuf,
      lngBuf,
      altitude,
      speedBuf,
      dirBuf,
      timeBcd,
    ]);
    this.sendPacket(MSG_ID.LOCATION, body);
  }

  handleData(data) {
    // Strip 0x7E framing markers
    let raw = data;
    if (raw[0] === 0x7e) raw = raw.slice(1);
    if (raw[raw.length - 1] === 0x7e) raw = raw.slice(0, -1);

    const packet = unescapeBuffer(raw);
    if (packet.length < 12) return;

    const msgId = packet.readUInt16BE(0);

    // Registration Response
    if (msgId === 0x8100) {
      const bodyStart = 12;
      const result = packet[bodyStart + 2];
      if (result === 0) {
        // Auth code is after serial(2) and result(1)
        this.authCode = packet
          .slice(bodyStart + 3, packet.length - 1)
          .toString();
        this.sendAuth();
      } else {
        console.log(`[${this.index}] Registration Failed (Code ${result})`);
        this.disconnect();
      }
    }
    // General Response
    else if (msgId === 0x8001) {
      const bodyStart = 12;
      const respToMsgId = packet.readUInt16BE(bodyStart + 2);
      const result = packet[bodyStart + 4];
      if (respToMsgId === MSG_ID.AUTH) {
        if (result === 0) {
          this.status = "STREAMING";
          this.startStreaming();
        } else {
          console.log(`[${this.index}] Auth rejected (result=${result})`);
          this.disconnect();
        }
      }
    }
  }
}

// ==========================================
// MAIN CLI
// ==========================================

const devices = [];
for (let i = 1; i <= CONFIG.NUM_DEVICES; i++) {
  devices.push(new VirtualDevice(i));
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("\n==============================================");
console.log("   ROAD-LOCKED GPS SIMULATOR (JT/T 808)");
console.log("==============================================");
console.log(`Target Server: ${CONFIG.HOST}:${CONFIG.PORT}`);
console.log(`Devices Ready: ${CONFIG.NUM_DEVICES} (Virtual Cars)`);
console.log(`Mode  : Roads Only (OSRM Routing)`);
console.log("----------------------------------------------");
console.log("Commands: start all | start <id> | stop all | status | exit");
console.log("==============================================\n");

function processCommand(cmd) {
  const parts = cmd.trim().toLowerCase().split(" ");
  const action = parts[0];
  const target = parts[1];

  if (action === "start") {
    if (target === "all") {
      console.log("Starting all devices (Staggered 1s for API)...");
      let delay = 0;
      devices.forEach((d) => {
        setTimeout(() => d.connect(), delay);
        delay += 1000; // Staggered start to respect routing API
      });
    } else if (target) {
      const idx = parseInt(target);
      if (devices[idx - 1]) devices[idx - 1].connect();
    }
  } else if (action === "stop") {
    if (target === "all") {
      devices.forEach((d) => d.disconnect());
    } else if (target) {
      const idx = parseInt(target);
      if (devices[idx - 1]) devices[idx - 1].disconnect();
    }
  } else if (action === "status") {
    console.log("\n--- Device Dashboard ---");
    devices.forEach((d, i) => {
      const info =
        d.status === "STREAMING"
          ? `Speed: ${d.speed}km/h | Route Points Left: ${d.route.length - d.routeIndex} | Lat: ${d.lat.toFixed(6)} Lng: ${d.lng.toFixed(6)}`
          : d.status;
      console.log(`[${i + 1}] ${d.imei} | ${info}`);
    });
    console.log("------------------------\n");
  } else if (action === "exit") {
    devices.forEach((d) => d.disconnect());
    process.exit(0);
  }
  rl.question("> ", processCommand);
}

rl.question("> ", processCommand);
