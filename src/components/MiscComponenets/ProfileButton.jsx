import { useState, useEffect, useRef } from 'react';
import { Bell, Search, User } from 'lucide-react';
import { useSupabase } from '../SupaBaseProvider';
import { useNavigate } from 'react-router-dom';


export default function ProfileButton  ()  {
  const { session, supabase } = useSupabase();
  const displayName = session?.user?.user_metadata?.full_name || session?.user?.email || 'User';
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef(null); // Ref for the dropdown
  const navigate = useNavigate()
  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/login')
    // window.location.reload(); // Reload the page to reset the session
  };
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false); // Close the dropdown
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  return (
    <div className="relative p-4" ref={dropdownRef}>
      <button
        className="flex items-center space-x-2 p-2 hover:bg-gray-100 rounded-lg"
        onClick={() => setIsDropdownOpen((prev) => !prev)}
      >
        <User className="w-5 h-5 text-gray-600" />
        <span className="text-sm text-gray-700">{displayName}</span>
      </button>
      {isDropdownOpen && (
        <div className="absolute right-0 mt-2 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-40">
          <button
            onClick={handleLogout}
            className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            Log Out
          </button>
        </div>
      )}
    </div>
  );
}