import React from 'react';
export const Label = React.forwardRef<HTMLLabelElement, any>((props, ref) => <label ref={ref} {...props} />);
