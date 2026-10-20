/** @type {import('next').NextConfig} */
const nextConfig = {
  // Hide the development status indicator; compile/runtime errors remain visible.
  devIndicators: false,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
