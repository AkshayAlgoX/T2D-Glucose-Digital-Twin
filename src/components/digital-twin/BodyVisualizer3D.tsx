'use client';

import React, { useRef, useMemo, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { 
  OrbitControls, 
  Environment, 
  ContactShadows,
  Float,
  Grid
} from '@react-three/drei';
import * as THREE from 'three';

// -----------------------------------------------------------------------------
// Contracts & Interfaces
// -----------------------------------------------------------------------------

type RiskTier = 'low' | 'elevated' | 'high';

export interface ForecastResponse {
  patientId: string;
  generatedAt: string;
  spike_risk: {
    tier: RiskTier;
  };
  // (Other fields omitted for brevity in this specific component)
}

export interface BodyVisualizer3DProps {
  forecast: ForecastResponse;
  className?: string;
}

// -----------------------------------------------------------------------------
// Internal Organ Mesh (Liver/Pancreas Region)
// -----------------------------------------------------------------------------

function MetabolicOrganGroup({ riskTier }: { riskTier: RiskTier }) {
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);
  const meshRef = useRef<THREE.Mesh>(null);

  // Map risk tiers to specific clinical hex colors
  const targetColor = useMemo(() => {
    switch (riskTier) {
      case 'high': 
        return new THREE.Color('#ef4444'); // Tailwind red-500
      case 'elevated': 
        return new THREE.Color('#f59e0b'); // Tailwind amber-500
      case 'low':
      default: 
        return new THREE.Color('#3b82f6'); // Tailwind blue-500
    }
  }, [riskTier]);

  useFrame((state, delta) => {
    if (materialRef.current) {
      // 1. Color Lerping: Smoothly transition between states if the stream updates
      materialRef.current.emissive.lerp(targetColor, delta * 2);
      materialRef.current.color.lerp(targetColor, delta * 2);

      // 2. Pulsation Math: Faster/more aggressive pulse for high risk
      const speed = riskTier === 'high' ? 4.5 : riskTier === 'elevated' ? 3.0 : 1.5;
      const baseIntensity = riskTier === 'low' ? 0.8 : 2.0;
      const amplitude = riskTier === 'low' ? 0.3 : 1.5;
      
      const pulse = baseIntensity + Math.sin(state.clock.elapsedTime * speed) * amplitude;
      materialRef.current.emissiveIntensity = pulse;
    }

    if (meshRef.current) {
      // Slight organic floating rotation
      meshRef.current.rotation.y += delta * 0.2;
      meshRef.current.rotation.z = Math.sin(state.clock.elapsedTime * 0.5) * 0.05;
    }
  });

  return (
    <group position={[-0.2, -0.1, 0.15]}>
      {/* 
        Position offsets approximate the left-central abdomen 
        where the pancreas and liver reside relative to the torso 
      */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.35, 64, 64]} />
        <meshStandardMaterial 
          ref={materialRef}
          color={targetColor}
          emissive={targetColor}
          emissiveIntensity={1}
          transparent
          opacity={0.9}
          roughness={0.2}
          toneMapped={false} // Crucial for Bloom/Glow effects
        />
      </mesh>
      
      {/* Secondary inner core to give the organ a "holographic depth" */}
      <mesh>
        <sphereGeometry args={[0.15, 32, 32]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.4} />
      </mesh>
    </group>
  );
}

// -----------------------------------------------------------------------------
// Torso "Hologram" Mesh
// -----------------------------------------------------------------------------

function HolographicTorso() {
  // We use a Capsule as an abstract, futuristic placeholder for the human torso.
  // In a real build, you swap <capsuleGeometry> for <primitive object={gltf.scene} />
  
  return (
    <mesh position={[0, 0, 0]} castShadow>
      <capsuleGeometry args={[1.2, 2.5, 32, 32]} />
      {/* 
        MeshPhysicalMaterial is required for the "Glass" or "Holographic" effect.
        Transmission handles the refraction, making the inner organs visible.
      */}
      <meshPhysicalMaterial 
        color="#0f172a" 
        transmission={0.9} 
        opacity={1} 
        transparent 
        metalness={0.1} 
        roughness={0.05} 
        ior={1.2} 
        thickness={1.5}
        envMapIntensity={1.0}
      />
    </mesh>
  );
}

// -----------------------------------------------------------------------------
// Main Canvas Component
// -----------------------------------------------------------------------------

export function BodyVisualizer3D({ forecast, className = '' }: BodyVisualizer3DProps) {
  const riskTier = forecast?.spike_risk?.tier || 'low';

  return (
    <div className={`w-full h-full relative rounded-2xl overflow-hidden bg-slate-950 ${className}`}>
      
      {/* UI Overlay */}
      <div className="absolute top-4 left-4 z-10">
        <h3 className="text-white/90 font-semibold tracking-tight text-sm uppercase">
          Metabolic Twin
        </h3>
        <p className="text-slate-400 text-xs">
          Organ Stress Level: <span className="font-bold text-white capitalize">{riskTier}</span>
        </p>
      </div>

      <Canvas 
        shadows 
        camera={{ position: [0, 0, 6], fov: 45 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
      >
        <Suspense fallback={null}>
          {/* Lighting Setup */}
          <ambientLight intensity={0.4} />
          <spotLight position={[5, 10, 5]} angle={0.2} penumbra={1} intensity={2} castShadow />
          <pointLight position={[-5, -5, -5]} intensity={1} color="#3b82f6" />
          
          {/* Environment for glass reflections */}
          <Environment preset="city" />

          {/* Group wrapper to add a gentle hover animation to the entire twin */}
          <Float speed={1.5} rotationIntensity={0.2} floatIntensity={0.5}>
            <group position={[0, 0.5, 0]}>
              <HolographicTorso />
              <MetabolicOrganGroup riskTier={riskTier} />
            </group>
          </Float>

          {/* Futuristic floor grid and shadows */}
          <Grid 
            renderOrder={-1} 
            position={[0, -2, 0]} 
            infiniteGrid 
            fadeDistance={20} 
            fadeStrength={5} 
            cellSize={0.5} 
            sectionSize={2.5}
            cellColor="#1e293b" 
            sectionColor="#334155" 
          />
          <ContactShadows 
            position={[0, -1.99, 0]} 
            opacity={0.8} 
            scale={10} 
            blur={2} 
            far={4} 
            color="#000000" 
          />
          
          <OrbitControls 
            enablePan={false}
            enableZoom={true}
            minDistance={4}
            maxDistance={10}
            minPolarAngle={Math.PI / 4} // Restrict looking strictly from top
            maxPolarAngle={Math.PI / 1.5} // Restrict looking under the floor
            autoRotate
            autoRotateSpeed={0.5}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}
