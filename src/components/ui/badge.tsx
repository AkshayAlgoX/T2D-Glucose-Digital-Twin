import React from 'react';
export const Badge = React.forwardRef<HTMLSpanElement, any>((props, ref) => <span ref={ref} {...props} />);
