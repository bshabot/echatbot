import React from 'react';
import { useMessage } from '../Messages/MessageContext';

const MessageBox = () => {
  const { message } = useMessage();

  if (!message) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[80] bg-blue-500 text-white p-4 rounded shadow-lg">
      {message}
    </div>
  );
};

export default MessageBox;