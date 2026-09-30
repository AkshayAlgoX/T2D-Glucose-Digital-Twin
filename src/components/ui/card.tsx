import React from 'react';
export const Card = React.forwardRef<HTMLDivElement, any>((props, ref) => <div ref={ref} {...props} />);
export const CardHeader = React.forwardRef<HTMLDivElement, any>((props, ref) => <div ref={ref} {...props} />);
export const CardTitle = React.forwardRef<HTMLDivElement, any>((props, ref) => <div ref={ref} {...props} />);
export const CardContent = React.forwardRef<HTMLDivElement, any>((props, ref) => <div ref={ref} {...props} />);
export const CardDescription = React.forwardRef<HTMLDivElement, any>((props, ref) => <div ref={ref} {...props} />);
export const CardFooter = React.forwardRef<HTMLDivElement, any>((props, ref) => <div ref={ref} {...props} />);
