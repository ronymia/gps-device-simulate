const net = require("net");
const readline = require("readline");

// ==========================================
// CONFIGURATION
// ==========================================

const CONFIG = {
  // 1. SERVER DETAILS (Your ai-dashcam-server backend)
  HOST: "54.37.225.65",
  PORT: 4017,
  // HOST: "0.0.0.0",
  // PORT: 3017,

  // 2. SIMULATION SETTINGS
  NUM_DEVICES: 5, // Total number of virtual cars
  CENTER_LAT: 51.5074, // Start Location: London, UK
  CENTER_LNG: -0.1278,
  SPREAD: 0.1, // How far cars spawn from center (~10km radius)

  // 3. TIMING
  GPS_INTERVAL_MS: 1000 * 10, // Send GPS every 10 seconds
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

// Generate a 15-digit IMEI based on index
function generateIMEI(index) {
  return `868120${String(index).padStart(9, "0")}`;
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

    // Movement
    // Random spawn within SPREAD degrees of center
    this.lat = CONFIG.CENTER_LAT + (Math.random() - 0.5) * 2 * CONFIG.SPREAD;
    this.lng = CONFIG.CENTER_LNG + (Math.random() - 0.5) * 2 * CONFIG.SPREAD;

    // Random speed: between 10 and 70 km/h
    this.speed = Math.floor(Math.random() * 60) + 10;

    // Random direction: 0-360 degrees
    this.direction = Math.floor(Math.random() * 360);
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
      console.log(
        `[Device ${this.index}] Connected to ${CONFIG.HOST}. Registering...`,
      );
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
    const manufacturer = Buffer.alloc(5);
    Buffer.from("SIMUL").copy(manufacturer);

    const model = Buffer.alloc(20);
    Buffer.from("MODEL01").copy(model);

    const terminalId = Buffer.alloc(7);
    Buffer.from(this.imei.slice(0, 7)).copy(terminalId);

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

  startStreaming() {
    this.status = "STREAMING";
    console.log(
      `[Device ${this.index}] ✅ Authenticated! Driving at ${this.speed}km/h heading ${Math.round(this.direction)}°`,
    );

    // Heartbeat every 30 seconds
    this.intervals.push(
      setInterval(() => {
        this.sendPacket(MSG_ID.HEARTBEAT, Buffer.alloc(0));
      }, 30000),
    );

    // GPS Location every GPS_INTERVAL_MS
    this.intervals.push(
      setInterval(() => {
        this.updatePosition();
        this.sendLocation();
      }, CONFIG.GPS_INTERVAL_MS),
    );
  }

  updatePosition() {
    // Add slight random turn to simulate road driving
    this.direction += Math.random() * 6 - 3;
    if (this.direction < 0) this.direction += 360;
    if (this.direction > 360) this.direction -= 360;

    // Calculate movement based on speed
    // Speed is km/h, time step is CONFIG.GPS_INTERVAL_MS
    // const kmPerMs = this.speed / 3600000;
    // const distKm = kmPerMs * CONFIG.GPS_INTERVAL_MS;
    // const distDeg = distKm / 111.0; // 1 deg ≈ 111km

    // const rad = (this.direction * Math.PI) / 180;

    // this.lat += Math.cos(rad) * distDeg;
    // this.lng += Math.sin(rad) * distDeg;
    const kmPerSec = this.speed / 3600;
    const distKm = kmPerSec * (CONFIG.GPS_INTERVAL_MS / 1000);

    const rad = (this.direction * Math.PI) / 180;
    const latDegPerKm = 1 / 111.32;
    const lngDegPerKm = 1 / (111.32 * Math.cos((this.lat * Math.PI) / 180));

    this.lat += distKm * Math.cos(rad) * latDegPerKm;
    this.lng += distKm * Math.sin(rad) * lngDegPerKm;
  }

  sendLocation() {
    const alarm = Buffer.alloc(4);
    const status = Buffer.alloc(4);
    let statusBits = 0b00000000000000000000000000000011; // Base: bit0=ACC ON, bit1=positioned
    let latValue = this.lat;
    let lngValue = this.lng;

    if (latValue < 0) {
      statusBits |= 1 << 2; // bit2=1 south latitude
      latValue = Math.abs(latValue);
    } // else bit2=0 north (London)

    if (lngValue < 0) {
      statusBits |= 1 << 3; // bit3=1 west longitude
      lngValue = Math.abs(lngValue);
    } // else bit3=0 east

    status.writeUInt32BE(statusBits);

    const lat = Buffer.alloc(4);
    lat.writeUInt32BE(Math.round(latValue * 1000000));

    const lng = Buffer.alloc(4);
    lng.writeUInt32BE(Math.round(lngValue * 1000000));

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
      lat,
      lng,
      altitude,
      speedBuf,
      dirBuf,
      timeBcd,
    ]);
    this.sendPacket(MSG_ID.LOCATION, body);
  }

  handleData(data) {
    // Strip leading/trailing 0x7E markers
    let raw = data;
    if (raw[0] === 0x7e) raw = raw.slice(1);
    if (raw[raw.length - 1] === 0x7e) raw = raw.slice(0, -1);

    const packet = unescapeBuffer(raw);

    if (packet.length < 12) return;

    const msgId = packet.readUInt16BE(0);

    // Registration Response (0x8100)
    if (msgId === 0x8100) {
      const bodyStart = 12; // After 2(msgId) + 2(props) + 6(phone) + 2(serial)
      const respSerial = packet.readUInt16BE(bodyStart);
      const result = packet[bodyStart + 2];

      if (result === 0) {
        // Extract auth code from body (after serial + result byte)
        this.authCode = packet
          .slice(bodyStart + 3, packet.length - 1)
          .toString();
        console.log(
          `[Device ${this.index}] Registered OK. Auth code: "${this.authCode}". Authenticating...`,
        );
        this.sendAuth();
      } else {
        console.log(
          `[Device ${this.index}] Registration Failed (Code ${result})`,
        );
        this.disconnect();
      }
    }
    // General Response (0x8001)
    else if (msgId === 0x8001) {
      const bodyStart = 12;
      const respSerial = packet.readUInt16BE(bodyStart);
      const respToMsgId = packet.readUInt16BE(bodyStart + 2);
      const result = packet[bodyStart + 4];

      if (respToMsgId === MSG_ID.AUTH) {
        if (result === 0) {
          console.log(`[Device ${this.index}] Auth accepted by server.`);
          this.startStreaming();
        } else {
          console.log(
            `[Device ${this.index}] Auth rejected (result=${result})`,
          );
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

// Initialize Devices
for (let i = 1; i <= CONFIG.NUM_DEVICES; i++) {
  devices.push(new VirtualDevice(i));
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("\n==============================================");
console.log("   GPS SIMULATOR - JT/T 808 PROTOCOL");
console.log("==============================================");
console.log(`Target Server: ${CONFIG.HOST}:${CONFIG.PORT}`);
console.log(`Devices Ready: ${CONFIG.NUM_DEVICES} (Virtual Cars)`);
console.log("----------------------------------------------");
console.log("Commands:");
console.log("  start all      - Start all 20 devices");
console.log("  start <id>     - Start specific device (1-20)");
console.log("  stop all       - Stop all devices");
console.log("  stop <id>      - Stop specific device");
console.log("  status         - Show device dashboard");
console.log("  exit           - Quit");
console.log("==============================================\n");

function processCommand(cmd) {
  const parts = cmd.trim().toLowerCase().split(" ");
  const action = parts[0];
  const target = parts[1];

  if (action === "start") {
    if (target === "all") {
      console.log("Starting all devices...");
      let delay = 0;
      devices.forEach((d) => {
        setTimeout(() => d.connect(), delay);
        delay += 100; // Stagger 100ms to avoid flooding
      });
    } else if (target) {
      const idx = parseInt(target);
      if (idx >= 1 && idx <= CONFIG.NUM_DEVICES && devices[idx - 1]) {
        devices[idx - 1].connect();
      } else {
        console.log(`Invalid ID. Use 1-${CONFIG.NUM_DEVICES}.`);
      }
    }
  } else if (action === "stop") {
    if (target === "all") {
      devices.forEach((d) => d.disconnect());
    } else if (target) {
      const idx = parseInt(target);
      if (idx >= 1 && idx <= CONFIG.NUM_DEVICES && devices[idx - 1]) {
        devices[idx - 1].disconnect();
      } else {
        console.log(`Invalid ID. Use 1-${CONFIG.NUM_DEVICES}.`);
      }
    }
  } else if (action === "status") {
    console.log("\n--- Device Dashboard ---");
    devices.forEach((d, i) => {
      const info =
        d.status === "STREAMING"
          ? `Speed: ${d.speed}km/h | Heading: ${Math.round(d.direction)}° | Lat: ${d.lat.toFixed(6)} Lng: ${d.lng.toFixed(6)}`
          : d.status;
      console.log(
        `  [${String(i + 1).padStart(2)}] ${d.imei} | ${d.plateNumber} | ${info}`,
      );
    });
    console.log("------------------------\n");
  } else if (action === "exit") {
    console.log("Shutting down all devices...");
    devices.forEach((d) => d.disconnect());
    process.exit(0);
  } else if (action) {
    console.log(
      `Unknown command: "${action}". Type: start all | stop all | status | exit`,
    );
  }

  rl.question("> ", processCommand);
}

rl.question("> ", processCommand);
