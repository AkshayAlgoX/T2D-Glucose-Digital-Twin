import React from 'react';
export const Progress = React.forwardRef<HTMLDivElement, any>((props, ref) => <div ref={ref} {...props} />);
