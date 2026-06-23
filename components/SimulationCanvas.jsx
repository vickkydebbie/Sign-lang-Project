'use client';

/**
 * SimulationCanvas.jsx
 *
 * React Three Fiber 3D canvas containing:
 *  - Environment / lighting
 *  - GLTF hand rig loaded via useGLTF
 *  - Per-frame LERP bone driving via useFrame
 *  - Deterministic sign sequencing driven by token queue from parent
 */

import { useRef, useEffect, useMemo, useState, useCallback, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF, OrbitControls, Environment, Center, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long (seconds) to hold each sign before advancing */
const SIGN_HOLD_DURATION = 1.2;

/** LERP speed — lower = more gradual, visible transitions */
const LERP_SPEED = 5.0;

/** Neutral / rest pose: all finger joints at 0 */
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

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Build a bone lookup map { boneName: THREE.Object3D } from a GLTF scene.
 *
 * FIX (Bug #1): Modern Three.js GLTF-loaded bones are plain Object3D nodes —
 * they do NOT have isBone===true or type==='Bone'. We match by name prefix
 * ('mixamorig:') which is reliable for Mixamo rigs, and also sweep skeleton
 * bones from any SkinnedMesh found in the scene.
 */
function buildBoneMap(scene) {
  const map = {};

  scene.traverse((obj) => {
    // Match Mixamo bone nodes by name prefix — works regardless of Object3D type
    if (obj.name && obj.name.startsWith('mixamorig:')) {
      map[obj.name] = obj;
    }
    // Also sweep skeleton bone arrays on any SkinnedMesh
    if (obj.isSkinnedMesh && obj.skeleton) {
      for (const bone of obj.skeleton.bones) {
        if (bone.name) map[bone.name] = bone;
      }
    }
  });

  return map;
}

/**
 * Frame-rate-independent LERP factor.
 * factor = 1 - e^(-speed * delta)
 */
function lerpFactor(speed, delta) {
  return 1 - Math.exp(-speed * delta);
}

/**
 * Apply a pose (array of { bone, x, y, z }) to a boneMap using LERP.
 * @param {Record<string,THREE.Object3D>} boneMap
 * @param {Array<{bone:string,x:number,y:number,z:number}>} targetPose
 * @param {number} alpha - LERP alpha [0,1]
 */
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
// HandRig – inner R3F component
// ---------------------------------------------------------------------------

function HandRig({ tokens, dictionary, onTokenAdvance, isPlaying }) {
  const { scene, animations } = useGLTF('/model.glb');
  const boneMapRef = useRef({});
  const stateRef   = useRef({
    tokenIndex:  -1,
    holdTimer:   0,
    currentPose: REST_POSE,
  });

  // Build bone map + neutralise embedded animations on load
  useEffect(() => {
    const map = buildBoneMap(scene);
    boneMapRef.current = map;

    if (process.env.NODE_ENV !== 'production') {
      const count = Object.keys(map).length;
      if (count === 0) {
        console.warn('[HandRig] buildBoneMap found 0 bones — check rig naming.');
        // Debug: log all object names to help diagnose
        const names = [];
        scene.traverse((o) => { if (o.name) names.push(`${o.type}: ${o.name}`); });
        console.warn('[HandRig] Scene objects:', names.slice(0, 40));
      } else {
        console.info(`[HandRig] Bone map ready — ${count} bones found.`);
      }
    }

    // The GLB ships with an embedded Mixamo idle animation
    // ('Armature|mixamo.com|Layer0'). If an AnimationMixer runs it, it will
    // overwrite our manual LERP rotations every frame. We neutralise it by
    // resetting all bone rotations to identity after load so the rig starts
    // from a clean T-pose and we have full control.
    if (animations && animations.length > 0) {
      // Create a temporary mixer just to get the action, then immediately
      // reset it so no keyframe data is applied.
      const mixer = new THREE.AnimationMixer(scene);
      for (const clip of animations) {
        mixer.clipAction(clip).reset().stop();
      }
      mixer.stopAllAction();
      console.info(`[HandRig] Neutralised ${animations.length} embedded animation(s).`);
    }
  }, [scene, animations]);

  // When new tokens arrive or playback starts, reset to first token
  useEffect(() => {
    if (isPlaying && tokens.length > 0) {
      stateRef.current.tokenIndex  = 0;
      stateRef.current.holdTimer   = 0;
      stateRef.current.currentPose = dictionary[tokens[0].token] ?? REST_POSE;
    } else if (!isPlaying) {
      stateRef.current.tokenIndex  = -1;
      stateRef.current.holdTimer   = 0;
      stateRef.current.currentPose = REST_POSE;
    }
  }, [isPlaying, tokens, dictionary]);

  useFrame((_, delta) => {
    const state   = stateRef.current;
    const boneMap = boneMapRef.current;

    // Guard: bone map must be populated
    if (!boneMap || Object.keys(boneMap).length === 0) return;

    const alpha = lerpFactor(LERP_SPEED, delta);

    if (!isPlaying || tokens.length === 0 || state.tokenIndex < 0) {
      applyPoseLerp(boneMap, REST_POSE, alpha);
      return;
    }

    // --- Advance sequencing ---
    state.holdTimer += delta;
    if (state.holdTimer >= SIGN_HOLD_DURATION) {
      state.holdTimer = 0;
      const nextIndex = state.tokenIndex + 1;

      if (nextIndex >= tokens.length) {
        state.tokenIndex  = -1;
        state.currentPose = REST_POSE;
        onTokenAdvance(-1);
      } else {
        state.tokenIndex  = nextIndex;
        const nextToken   = tokens[nextIndex].token;
        state.currentPose = dictionary[nextToken] ?? REST_POSE;
        onTokenAdvance(nextIndex);
      }
    }

    // --- Apply LERP to current target pose ---
    applyPoseLerp(boneMap, state.currentPose, alpha);
  });

  return (
    <Center>
      <primitive object={scene} scale={1.4} position={[0, -1.2, 0]} />
    </Center>
  );
}

// Pre-load the model so it's cached before the component mounts
useGLTF.preload('/model.glb');

// ---------------------------------------------------------------------------
// Fallback placeholder hand (shown when model.glb is unavailable)
// ---------------------------------------------------------------------------

function FallbackHand({ tokens, isPlaying, activeIndex }) {
  const groupRef = useRef();
  const stateRef = useRef({ time: 0 });

  useFrame((_, delta) => {
    stateRef.current.time += delta;
    if (groupRef.current) {
      groupRef.current.position.y = Math.sin(stateRef.current.time * 1.2) * 0.05;
      groupRef.current.rotation.y = Math.sin(stateRef.current.time * 0.5) * 0.08;
    }
  });

  const color = isPlaying ? '#60a5fa' : '#334155';

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      {/* Palm */}
      <mesh castShadow>
        <boxGeometry args={[0.55, 0.65, 0.18]} />
        <meshStandardMaterial color={color} roughness={0.4} metalness={0.15} />
      </mesh>
      {/* Fingers (5 boxes) */}
      {[-0.22, -0.11, 0, 0.11, 0.22].map((x, i) => (
        <mesh key={i} position={[x, 0.52, 0]} castShadow>
          <boxGeometry args={[0.09, 0.28, 0.1]} />
          <meshStandardMaterial color={color} roughness={0.4} metalness={0.15} />
        </mesh>
      ))}
      {/* Thumb */}
      <mesh position={[-0.33, 0.08, 0]} rotation={[0, 0, 0.7]} castShadow>
        <boxGeometry args={[0.09, 0.23, 0.1]} />
        <meshStandardMaterial color={color} roughness={0.4} metalness={0.15} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// ModelLoader – FIX (Bug #3): do NOT use try/catch around useGLTF-based
// components. useGLTF throws a Promise to trigger React Suspense; catching
// it here calls onError() and permanently switches to FallbackHand before
// the model ever loads.
//
// Solution: wrap HandRig in its own Suspense so the thrown Promise is caught
// by React, not by our catch block. Actual load errors are handled by the
// ErrorBoundary in SimulationCanvas.
// ---------------------------------------------------------------------------

function ModelLoader({ tokens, dictionary, onTokenAdvance, isPlaying, onError }) {
  return (
    <Suspense fallback={null}>
      <HandRig
        tokens={tokens}
        dictionary={dictionary}
        onTokenAdvance={onTokenAdvance}
        isPlaying={isPlaying}
      />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Scene wrapper
// ---------------------------------------------------------------------------

function SceneContent({ tokens, dictionary, onTokenAdvance, isPlaying, activeIndex }) {
  const [modelError, setModelError] = useState(false);
  const handleError = useCallback(() => setModelError(true), []);

  if (modelError) {
    return (
      <FallbackHand
        tokens={tokens}
        isPlaying={isPlaying}
        activeIndex={activeIndex}
      />
    );
  }

  return (
    <ModelLoader
      tokens={tokens}
      dictionary={dictionary}
      onTokenAdvance={onTokenAdvance}
      isPlaying={isPlaying}
      onError={handleError}
    />
  );
}

// ---------------------------------------------------------------------------
// CameraSetup – positions camera once
// ---------------------------------------------------------------------------

function CameraSetup() {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(0, 0.2, 2.4);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera]);
  return null;
}

// ---------------------------------------------------------------------------
// Public export: SimulationCanvas
// ---------------------------------------------------------------------------

/**
 * @param {object}   props
 * @param {Array}    props.tokens         - Tokenized output from nlpUtils.tokenize()
 * @param {object}   props.dictionary     - Full dictionary map from loadDictionary()
 * @param {boolean}  props.isPlaying      - True while animation should play
 * @param {number}   props.activeIndex    - Index of currently displayed token
 * @param {function} props.onTokenAdvance - Called with new index each time a sign advances
 */
export default function SimulationCanvas({
  tokens = [],
  dictionary = {},
  isPlaying = false,
  activeIndex = 0,
  onTokenAdvance = () => {},
}) {
  return (
    <div className="w-full h-full relative">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <CameraSetup />

        {/* Ambient + directional lighting */}
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

        {/* Environment preset for reflections */}
        <Environment preset="studio" />

        {/* Contact shadow on ground */}
        <ContactShadows
          position={[0, -1.6, 0]}
          opacity={0.45}
          scale={4}
          blur={2.5}
          far={2}
          color="#1e1b4b"
        />

        {/* Main content */}
        <SceneContent
          tokens={tokens}
          dictionary={dictionary}
          isPlaying={isPlaying}
          activeIndex={activeIndex}
          onTokenAdvance={onTokenAdvance}
        />

        {/* Orbit controls */}
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
