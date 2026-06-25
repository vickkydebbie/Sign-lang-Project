'use client';

/**
 * SimulationCanvas.jsx  —  Sprint 3
 *
 * Upgrades over Sprint 2:
 *  - signSpeed prop (0.5×–2×) scales SIGN_HOLD_DURATION per-frame
 *  - Two-phase sign transitions: each sign briefly returns to REST before
 *    advancing, making individual signs visually distinct
 *  - Idle breathing animation (subtle wrist oscillation when not signing)
 *  - cameraPreset prop: 'front' | 'side' | 'angle' repositions camera
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF, OrbitControls, Environment, Center, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base hold time per sign in seconds (scaled by signSpeed prop) */
const BASE_HOLD_DURATION = 0.9;

/** Fraction of hold time spent in REST "buffer" between signs */
const TRANSITION_FRACTION = 0.25;

/** LERP speed during active signing */
const LERP_SPEED = 8.0;

/** Faster LERP for the REST buffer phase */
const LERP_SPEED_REST = 14.0;

/** Neutral / rest pose */
const REST_POSE = [
  { bone: 'mixamorig:RightHand',        x: 0, y: 0,    z: -0.15 },
  { bone: 'mixamorig:RightHandThumb1',  x: 0, y: 0.3,  z: 0.2   },
  { bone: 'mixamorig:RightHandThumb2',  x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandThumb3',  x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandIndex1',  x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandIndex2',  x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandIndex3',  x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandMiddle1', x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandMiddle2', x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandMiddle3', x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandRing1',   x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandRing2',   x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandRing3',   x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandPinky1',  x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandPinky2',  x: 0, y: 0,    z: 0     },
  { bone: 'mixamorig:RightHandPinky3',  x: 0, y: 0,    z: 0     },
];

// Camera preset positions [x, y, z] and lookAt target
const CAMERA_PRESETS = {
  front: { pos: [0,  0.2, 2.4], look: [0, 0, 0] },
  side:  { pos: [2.2, 0.2, 1.2], look: [0, 0, 0] },
  angle: { pos: [1.4, 0.6, 2.0], look: [0, -0.1, 0] },
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function buildBoneMap(scene) {
  const map = {};
  scene.traverse((obj) => {
    if (obj.isBone || obj.type === 'Bone') map[obj.name] = obj;
    if (obj.isSkinnedMesh && obj.skeleton) {
      for (const bone of obj.skeleton.bones) map[bone.name] = bone;
    }
  });
  return map;
}

function detectBonePrefix(boneMap) {
  const names = Object.keys(boneMap);
  if (names.some((n) => n.startsWith('mixamorig1:'))) return 'mixamorig1:';
  return 'mixamorig:';
}

function remapPosePrefix(pose, detectedPrefix) {
  const SRC = 'mixamorig:';
  if (detectedPrefix === SRC) return pose;
  return pose.map(({ bone, x, y, z }) => ({
    bone: bone.replace(SRC, detectedPrefix), x, y, z,
  }));
}

/** Frame-rate-independent LERP factor via exponential decay */
function lerpFactor(speed, delta) {
  return 1 - Math.exp(-speed * delta);
}

function applyPoseLerp(boneMap, targetPose, alpha) {
  for (const { bone: boneName, x, y, z } of targetPose) {
    const bone = boneMap[boneName];
    if (!bone) continue;
    bone.rotation.x = THREE.MathUtils.lerp(bone.rotation.x, x, alpha);
    bone.rotation.y = THREE.MathUtils.lerp(bone.rotation.y, y, alpha);
    bone.rotation.z = THREE.MathUtils.lerp(bone.rotation.z, z, alpha);
  }
}

// ---------------------------------------------------------------------------
// CameraController — smooth camera transitions on preset change
// ---------------------------------------------------------------------------

function CameraController({ preset }) {
  const { camera } = useThree();
  const targetRef = useRef(CAMERA_PRESETS.front);
  const timeRef   = useRef(0);

  useEffect(() => {
    targetRef.current = CAMERA_PRESETS[preset] ?? CAMERA_PRESETS.front;
    timeRef.current   = 0;
  }, [preset]);

  // Initial position
  useEffect(() => {
    const { pos, look } = CAMERA_PRESETS.front;
    camera.position.set(...pos);
    camera.lookAt(...look);
    camera.updateProjectionMatrix();
  }, [camera]);

  useFrame((_, delta) => {
    const { pos, look } = targetRef.current;
    timeRef.current += delta;
    const t = Math.min(timeRef.current / 0.6, 1); // 600ms transition
    const alpha = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out

    camera.position.x = THREE.MathUtils.lerp(camera.position.x, pos[0], alpha * delta * 5);
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, pos[1], alpha * delta * 5);
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, pos[2], alpha * delta * 5);
    camera.lookAt(...look);
  });

  return null;
}

// ---------------------------------------------------------------------------
// HandRig — Sprint 3: two-phase transitions + idle breathing + speed scaling
// ---------------------------------------------------------------------------

function HandRig({ tokens, dictionary, onTokenAdvance, isPlaying, signSpeed }) {
  const { scene } = useGLTF('/model.glb');
  const boneMapRef    = useRef({});
  const bonePrefixRef = useRef('mixamorig:');
  const timeRef       = useRef(0); // for idle breathing

  /**
   * phase: 'sign'   — showing the target pose
   *        'buffer' — briefly returning to REST before advancing
   */
  const stateRef = useRef({
    tokenIndex:  -1,
    holdTimer:   0,
    phase:       'sign',
    currentPose: REST_POSE,
    nextPose:    REST_POSE,
  });

  // Build bone map + detect prefix on model load
  useEffect(() => {
    const map    = buildBoneMap(scene);
    const prefix = detectBonePrefix(map);
    boneMapRef.current    = map;
    bonePrefixRef.current = prefix;

    // ── DEBUG: log scene contents to browser console ──
    const meshes = [];
    const bones  = [];
    scene.traverse((obj) => {
      if (obj.isMesh)       meshes.push(`MESH: ${obj.name} (verts: ${obj.geometry?.attributes?.position?.count ?? '?'})`);
      if (obj.isBone)       bones.push(`BONE: ${obj.name}`);
    });
    console.group('%c[ASL] model.glb scene contents', 'color:#60a5fa;font-weight:bold');
    console.log('Detected bone prefix:', prefix);
    console.log(`Meshes (${meshes.length}):`, meshes.length ? meshes : '⚠️ NONE — model has no visible geometry!');
    console.log(`Bones  (${bones.length}):`, bones.length ? bones.slice(0, 8) : '⚠️ NONE');
    if (meshes.length === 0) console.warn('❌ model.glb contains no mesh geometry. Replace public/model.glb with your actual avatar GLB file.');
    console.groupEnd();
    stateRef.current.currentPose = remapPosePrefix(REST_POSE, prefix);
    stateRef.current.nextPose    = remapPosePrefix(REST_POSE, prefix);
  }, [scene]);

  // Reset when tokens/playback changes
  useEffect(() => {
    const prefix = bonePrefixRef.current;
    if (isPlaying && tokens.length > 0) {
      const rawPose = dictionary[tokens[0].token] ?? REST_POSE;
      stateRef.current.tokenIndex  = 0;
      stateRef.current.holdTimer   = 0;
      stateRef.current.phase       = 'sign';
      stateRef.current.currentPose = remapPosePrefix(rawPose, prefix);
    } else if (!isPlaying) {
      stateRef.current.tokenIndex  = -1;
      stateRef.current.holdTimer   = 0;
      stateRef.current.phase       = 'sign';
      stateRef.current.currentPose = remapPosePrefix(REST_POSE, prefix);
    }
  }, [isPlaying, tokens, dictionary]);

  useFrame((_, delta) => {
    const state   = stateRef.current;
    const boneMap = boneMapRef.current;
    const prefix  = bonePrefixRef.current;
    if (!boneMap || Object.keys(boneMap).length === 0) return;

    const speed     = Math.max(0.25, Math.min(signSpeed ?? 1.0, 3.0));
    const holdTime  = BASE_HOLD_DURATION / speed;
    const bufTime   = holdTime * TRANSITION_FRACTION;
    const signTime  = holdTime - bufTime;

    // ── Idle mode: breathing oscillation on wrist bone ──
    if (!isPlaying || tokens.length === 0 || state.tokenIndex < 0) {
      timeRef.current += delta;
      const restPoseMapped = remapPosePrefix(REST_POSE, prefix);
      const alpha = lerpFactor(LERP_SPEED, delta);
      applyPoseLerp(boneMap, restPoseMapped, alpha);

      // Subtle idle breathing: oscillate wrist Z
      const wristName = `${prefix}RightHand`;
      const wrist = boneMap[wristName];
      if (wrist) {
        wrist.rotation.z = THREE.MathUtils.lerp(
          wrist.rotation.z,
          -0.15 + Math.sin(timeRef.current * 1.1) * 0.04,
          0.05
        );
        wrist.rotation.y = THREE.MathUtils.lerp(
          wrist.rotation.y,
          Math.sin(timeRef.current * 0.7) * 0.03,
          0.03
        );
      }
      return;
    }

    // ── Active sequencing ──
    state.holdTimer += delta;

    if (state.phase === 'sign' && state.holdTimer >= signTime) {
      // Transition to REST buffer before advancing
      state.holdTimer   = 0;
      state.phase       = 'buffer';
      state.currentPose = remapPosePrefix(REST_POSE, prefix);
    } else if (state.phase === 'buffer' && state.holdTimer >= bufTime) {
      // Buffer done — advance to next token
      state.holdTimer = 0;
      state.phase     = 'sign';
      const nextIndex = state.tokenIndex + 1;

      if (nextIndex >= tokens.length) {
        state.tokenIndex  = -1;
        state.currentPose = remapPosePrefix(REST_POSE, prefix);
        onTokenAdvance(-1);
      } else {
        state.tokenIndex  = nextIndex;
        const rawPose     = dictionary[tokens[nextIndex].token] ?? REST_POSE;
        state.currentPose = remapPosePrefix(rawPose, prefix);
        onTokenAdvance(nextIndex);
      }
    }

    // Apply pose — use faster LERP during REST buffer for snappy reset
    const lerpSpd = state.phase === 'buffer' ? LERP_SPEED_REST : LERP_SPEED;
    applyPoseLerp(boneMap, state.currentPose, lerpFactor(lerpSpd, delta));
  });

  return (
    <Center>
      <primitive object={scene} scale={1.4} position={[0, -1.2, 0]} />
    </Center>
  );
}

useGLTF.preload('/model.glb');

// ---------------------------------------------------------------------------
// Fallback procedural hand
// ---------------------------------------------------------------------------

function FallbackHand({ tokens, isPlaying, activeIndex }) {
  const groupRef = useRef();
  const timeRef  = useRef(0);

  useFrame((_, delta) => {
    timeRef.current += delta;
    if (groupRef.current) {
      groupRef.current.position.y = Math.sin(timeRef.current * 1.2) * 0.05;
      groupRef.current.rotation.y = Math.sin(timeRef.current * 0.5) * 0.08;
    }
  });

  const color = isPlaying ? '#60a5fa' : '#334155';
  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      <mesh castShadow>
        <boxGeometry args={[0.55, 0.65, 0.18]} />
        <meshStandardMaterial color={color} roughness={0.4} metalness={0.15} />
      </mesh>
      {[-0.22, -0.11, 0, 0.11, 0.22].map((x, i) => (
        <mesh key={i} position={[x, 0.52, 0]} castShadow>
          <boxGeometry args={[0.09, 0.28, 0.1]} />
          <meshStandardMaterial color={color} roughness={0.4} metalness={0.15} />
        </mesh>
      ))}
      <mesh position={[-0.33, 0.08, 0]} rotation={[0, 0, 0.7]} castShadow>
        <boxGeometry args={[0.09, 0.23, 0.1]} />
        <meshStandardMaterial color={color} roughness={0.4} metalness={0.15} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Scene content wrapper
// ---------------------------------------------------------------------------

function SceneContent({ tokens, dictionary, onTokenAdvance, isPlaying, activeIndex, signSpeed }) {
  const [modelError, setModelError] = useState(false);
  const handleError = useCallback(() => setModelError(true), []);

  if (modelError) {
    return <FallbackHand tokens={tokens} isPlaying={isPlaying} activeIndex={activeIndex} />;
  }
  return (
    <ModelLoader
      tokens={tokens}
      dictionary={dictionary}
      onTokenAdvance={onTokenAdvance}
      isPlaying={isPlaying}
      signSpeed={signSpeed}
      onError={handleError}
    />
  );
}

function ModelLoader({ tokens, dictionary, onTokenAdvance, isPlaying, signSpeed, onError }) {
  try {
    return (
      <HandRig
        tokens={tokens}
        dictionary={dictionary}
        onTokenAdvance={onTokenAdvance}
        isPlaying={isPlaying}
        signSpeed={signSpeed}
      />
    );
  } catch {
    onError();
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * @param {object}   props
 * @param {Array}    props.tokens         - Tokenized output from nlpUtils
 * @param {object}   props.dictionary     - Full dictionary map
 * @param {boolean}  props.isPlaying      - Playback state
 * @param {number}   props.activeIndex    - Current token index
 * @param {function} props.onTokenAdvance - Callback on sign advance
 * @param {number}   props.signSpeed      - Speed multiplier 0.5–2.0
 * @param {string}   props.cameraPreset   - 'front' | 'side' | 'angle'
 */
export default function SimulationCanvas({
  tokens        = [],
  dictionary    = {},
  isPlaying     = false,
  activeIndex   = 0,
  onTokenAdvance = () => {},
  signSpeed     = 1.0,
  cameraPreset  = 'front',
}) {
  return (
    <div className="w-full h-full relative">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <CameraController preset={cameraPreset} />

        {/* Lighting */}
        <ambientLight intensity={0.6} />
        <directionalLight
          castShadow
          position={[3, 8, 5]}
          intensity={1.4}
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-camera-near={0.5}
          shadow-camera-far={30}
          shadow-camera-left={-5}
          shadow-camera-right={5}
          shadow-camera-top={5}
          shadow-camera-bottom={-5}
        />
        <pointLight position={[-4, 2, -4]} intensity={0.4} color="#a78bfa" />
        <pointLight position={[4, 1, 2]}  intensity={0.3} color="#60a5fa" />

        <Environment preset="studio" />

        <ContactShadows
          position={[0, -1.6, 0]}
          opacity={0.45}
          scale={4}
          blur={2.5}
          far={2}
          color="#1e1b4b"
        />

        <SceneContent
          tokens={tokens}
          dictionary={dictionary}
          isPlaying={isPlaying}
          activeIndex={activeIndex}
          onTokenAdvance={onTokenAdvance}
          signSpeed={signSpeed}
        />

        <OrbitControls
          enablePan={false}
          minDistance={1.2}
          maxDistance={5}
          minPolarAngle={Math.PI / 6}
          maxPolarAngle={Math.PI / 1.5}
          target={[0, 0, 0]}
        />
      </Canvas>
    </div>
  );
}
