import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

// ---------- Renderer / Scene / Camera ----------
const container = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  45,
  container.clientWidth / container.clientHeight,
  0.1,
  10000
);
camera.position.set(0, 80, 220);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---------- Starfield ----------
const starGeo = new THREE.SphereGeometry(5000, 64, 64);
const starMat = new THREE.MeshBasicMaterial({ color: 0x0b0b16, side: THREE.BackSide });
scene.add(new THREE.Mesh(starGeo, starMat));

// ---------- Lights ----------
scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 0.3));
const sunLight = new THREE.PointLight(0xffffff, 2.2, 0, 2);
scene.add(sunLight);

// ---------- Sun ----------
const sun = new THREE.Mesh(
  new THREE.SphereGeometry(16, 64, 64),
  new THREE.MeshBasicMaterial({ color: 0xffe080 })
);
scene.add(sun);
sunLight.position.copy(sun.position);

// ---------- Helpers ----------
const grid = new THREE.GridHelper(600, 60, 0x333333, 0x111111);
grid.material.transparent = true;
grid.material.opacity = 0.15;
scene.add(grid);

// ---------- Bloom (post-processing) ----------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(container.clientWidth, container.clientHeight),
  0.6,   // strength
  0.9,   // radius
  0.25   // threshold
);
composer.addPass(bloomPass);

// Slight emissive on planets helps them “catch” bloom
const planetMat = (color) =>
  new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(0.05),
    metalness: 0.0,
    roughness: 1.0
  });

// ---------- “Real-ish” orbits (AU & sidereal periods) ----------
const AU = 50; // scale: 1 AU -> 50 scene units (tweak to taste)
const PLANETS = [
  { name: 'Mercury', radius: 1.3,  a_AU: 0.387, period_days: 87.969,   color: 0xaaaaaa },
  { name: 'Venus',   radius: 2.1,  a_AU: 0.723, period_days: 224.701, color: 0xffd27f },
  { name: 'Earth',   radius: 2.2,  a_AU: 1.000, period_days: 365.256, color: 0x3ba3ff },
  { name: 'Mars',    radius: 1.8,  a_AU: 1.524, period_days: 686.980, color: 0xff6a4b },
  { name: 'Jupiter', radius: 8.5,  a_AU: 5.203, period_days: 4332.59, color: 0xffaa00 },
  { name: 'Saturn',  radius: 7.3,  a_AU: 9.537, period_days: 10759.2, color: 0xffe680 },
  { name: 'Uranus',  radius: 3.7,  a_AU: 19.191,period_days: 30685.4, color: 0x80ffff },
  { name: 'Neptune', radius: 3.5,  a_AU: 30.07, period_days: 60190,   color: 0x5f7dff }
];

// Use current time to seed initial mean anomalies (circular, coplanar approximation)
const now = Date.now();
const dayMs = 86400000;

// Optional per-planet phase offsets to spread things out a bit (radians)
const phaseOffsets = {
  Mercury: 0.1, Venus: 1.2, Earth: 2.1, Mars: 3.0,
  Jupiter: 0.5, Saturn: 1.6, Uranus: 2.7, Neptune: 3.8
};

function makePlanet(p) {
  const group = new THREE.Group();
  scene.add(group);

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(p.radius, 32, 32),
    planetMat(p.color)
  );
  // place at semi-major axis on X
  mesh.position.x = p.a_AU * AU;
  group.add(mesh);

  // seed starting angle from time (approx)
  const meanMotion = (2 * Math.PI) / (p.period_days * dayMs);
  const t0 = now % (p.period_days * dayMs);
  group.rotation.y = meanMotion * t0 + (phaseOffsets[p.name] || 0);

  return {
    name: p.name,
    group,
    mesh,
    meanMotion,           // radians per ms
    spin: 0.01 + Math.random() * 0.02 // axial spin variety
  };
}

const planets = PLANETS.map(makePlanet);

// Earth’s moon (fixed local orbit)
const earth = planets.find(p => p.name === 'Earth');
const moonGroup = new THREE.Group();
earth.mesh.add(moonGroup);
const moon = new THREE.Mesh(
  new THREE.SphereGeometry(0.7, 24, 24),
  planetMat(0xcccccc)
);
moon.position.x = 5.5;
moonGroup.add(moon);
let moonAngle = Math.random() * Math.PI * 2;

// Orbit rings (visual)
function makeOrbitRing(distance) {
  const curve = new THREE.EllipseCurve(0, 0, distance, distance);
  const pts = curve.getPoints(256).map(p => new THREE.Vector3(p.x, 0.01, p.y));
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0x333344 });
  scene.add(new THREE.LineLoop(geo, mat));
}
PLANETS.forEach(p => makeOrbitRing(p.a_AU * AU));

// ---------- Resize ----------
function onResize() {
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

// ---------- Animation ----------
const clock = new THREE.Clock();
let timeScale = 0.15; // slower animation (adjust live if you want)

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();         // seconds
  const dtMs = dt * 1000;              // milliseconds

  // Sun glow + subtle spin
  sun.material.color.offsetHSL(0, 0, 0); // placeholder to avoid GC
  sun.rotation.y += 0.002 * timeScale;

  // Update orbits using mean motion (approx circular orbits)
  planets.forEach(p => {
    p.group.rotation.y += p.meanMotion * dtMs * timeScale;
    p.mesh.rotation.y += p.spin * timeScale;
  });

  // Moon orbit (28-ish days scaled)
  moonAngle += (2 * Math.PI / (27.3 * dayMs)) * dtMs * timeScale;
  moonGroup.rotation.y = moonAngle;

  controls.update();
  composer.render();
}
animate();
