import { useState, useEffect, useRef } from 'react';
import { Bell, Search, User } from 'lucide-react';
import { useSupabase } from '../components/SupaBaseProvider';
import { useNavigate } from 'react-router-dom';
import SearchBar from './SearchBar';

export default function Header() {
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

  // Close dropdown if clicked outside
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
    <header className="h-16 bg-white border-b border-gray-200 fixed top-0 right-0 left-64 z-30">
      <div className="h-full px-6 flex items-center justify-between">
        <div className="flex items-center flex-1">
            {/* <SearchBar type={'search'}/> */}
            {/* <input
              type="text"
              placeholder="Search..."
              className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            /> */}
        </div>

        <div className="flex items-center space-x-4">
          {/* <button className="p-2 hover:bg-gray-100 rounded-full relative">
            <Bell className="w-5 h-5 text-gray-600" />
            <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
          </button> */}
          <div className="relative" ref={dropdownRef}>
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
        </div>
      </div>
    </header>
  );
};
