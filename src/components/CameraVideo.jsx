import { forwardRef } from 'react';

const CameraVideo = forwardRef(({ isVisible = true, style = {}, ...props }, ref) => {
  return (
    <video
      ref={ref}
      className={`camera-video fixed top-0 left-0 w-screen h-screen object-cover z-10 ${
        isVisible ? 'block' : 'hidden'
      }`}
      style={style}
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
