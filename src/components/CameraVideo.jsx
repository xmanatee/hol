import { forwardRef } from 'react';

const CameraVideo = forwardRef(({ isVisible = true, mirrored = false, style = {}, ...props }, ref) => {
  return (
    <video
      ref={ref}
      className={`camera-video fixed top-0 left-0 w-screen h-screen object-cover z-10 ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
      style={{
        ...style,
        transform: mirrored ? 'scaleX(-1)' : 'none',
      }}
      aria-hidden="true"
      playsInline
      webkit-playsinline=""
      muted
      autoPlay
      {...props}
    />
  );
});

CameraVideo.displayName = 'CameraVideo';

export default CameraVideo;
