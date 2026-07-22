import React from 'react';
import { useMessage } from '../Messages/MessageContext';

const MessageBox = () => {
  const { message } = useMessage();

  if (!message) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[80] bg-blue-500 text-white p-4 rounded shadow-lg max-md:left-4 max-md:text-sm max-md:text-center max-md:bottom-[max(1rem,env(safe-area-inset-bottom))]">
      {message}
    </div>
  );
};

export default MessageBox;