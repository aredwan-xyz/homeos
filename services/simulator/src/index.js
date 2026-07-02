import mqtt from 'mqtt';

const mq = mqtt.connect(process.env.MQTT_URL || 'mqtt://localhost:1883');

const rooms = {
  living:  { temp: 22.4, setpoint: 22, lights: { on: true,  level: 70 }, occupants: 2 },
  kitchen: { temp: 23.1, setpoint: 22, lights: { on: false, level: 0 },  occupants: 1 },
  studio:  { temp: 21.2, setpoint: 21, lights: { on: true,  level: 85 }, occupants: 1 },
  bedroom: { temp: 20.6, setpoint: 20, lights: { on: false, level: 0 },  occupants: 0 },
  bath:    { temp: 22.0, setpoint: 22, lights: { on: false, level: 0 },  occupants: 0 }
};

const scenes = {
  focus: (r) => {
    r.setpoint = 21;
    r.lights.on = r.occupants > 0;
    r.lights.level = r.lights.on ? 90 : 0;
  },
  relax: (r) => {
    r.setpoint = 23;
    r.lights.on = r.occupants > 0;
    r.lights.level = r.lights.on ? 40 : 0;
  },
  away: (r) => {
    r.setpoint = 18;
    r.lights.on = false;
    r.lights.level = 0;
    r.occupants = 0;
  }
};

function power() {
  let watts = 120;
  for (const r of Object.values(rooms)) {
    watts += r.lights.on ? r.lights.level * 1.6 : 0;
    watts += Math.abs(r.setpoint - r.temp) * 55;
    watts += r.occupants * 15;
  }
  return watts + (Math.random() - 0.5) * 24;
}

function publishState(name) {
  const r = rooms[name];
  const opts = { retain: true };
  mq.publish(`homeos/state/${name}/lights`, JSON.stringify(r.lights), opts);
  mq.publish(`homeos/state/${name}/climate`, JSON.stringify({ setpoint: r.setpoint }), opts);
  mq.publish(`homeos/state/${name}/presence`, JSON.stringify({ occupants: r.occupants }), opts);
}

mq.on('connect', () => {
  console.log('simulator: mqtt connected');
  mq.subscribe('homeos/cmd/#');
  for (const name of Object.keys(rooms)) publishState(name);
});

mq.on('message', (topic, payload) => {
  const [, , room] = topic.split('/');
  let action;
  try {
    action = JSON.parse(payload.toString());
  } catch {
    return;
  }
  const targets = room === 'all' ? Object.keys(rooms) : rooms[room] ? [room] : [];
  setTimeout(() => {
    for (const name of targets) {
      const r = rooms[name];
      if (action.type === 'setpoint' && Number.isFinite(action.value)) {
        r.setpoint = Math.min(Math.max(action.value, 10), 30);
      } else if (action.type === 'lights') {
        r.lights.on = Boolean(action.on);
        r.lights.level = r.lights.on ? Math.min(Math.max(action.level ?? 75, 1), 100) : 0;
      } else if (action.type === 'scene' && scenes[action.name]) {
        scenes[action.name](r);
      }
      publishState(name);
    }
    console.log('simulator: applied', room, JSON.stringify(action));
  }, 150);
});

setInterval(() => {
  for (const [name, r] of Object.entries(rooms)) {
    r.temp += (r.setpoint - r.temp) * 0.08 + (Math.random() - 0.5) * 0.12;
    if (Math.random() < 0.04) {
      r.occupants = Math.max(0, Math.min(3, r.occupants + (Math.random() < 0.5 ? -1 : 1)));
      mq.publish(`homeos/state/${name}/presence`, JSON.stringify({ occupants: r.occupants }), { retain: true });
    }
    mq.publish(`homeos/tele/${name}/climate/temp`, r.temp.toFixed(2));
    mq.publish(`homeos/tele/${name}/climate/co2`, String(Math.round(420 + r.occupants * 38 + Math.random() * 20)));
  }
  mq.publish('homeos/tele/home/meter/power', power().toFixed(1));
}, 2000);
