import React from 'react';
export const Button = React.forwardRef<HTMLButtonElement, any>((props, ref) => <button ref={ref} {...props} />);
