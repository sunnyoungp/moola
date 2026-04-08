import React, { useState, useEffect } from 'react';

// Assuming exchange rates are fetched globally or passed by Context
// Example base USD: { USD: 1, KRW: 1400, EUR: 0.9 }
const EXCHANGE_RATES: Record<string, number> = {
  USD: 1,
  KRW: 1400,
  EUR: 0.9,
};

// Pure utility functions
function formatDisplayBalance(valueStr: string, currency: string) {
  if (!valueStr) return '';
  const num = parseFloat(valueStr);
  if (isNaN(num)) return valueStr;
  
  // Conditionally format (0 decimals for KRW, 2 for USD/EUR, etc.)
  const isKRW = currency === 'KRW';
  return num.toLocaleString('en-US', {
    maximumFractionDigits: isKRW ? 0 : 2,
  });
}

function convertCurrency(amount: number, fromCurrency: string, toCurrency: string) {
  if (fromCurrency === toCurrency) return amount;
  // Convert to Base USD first, then into your Target Currency
  const baseUsd = amount / EXCHANGE_RATES[fromCurrency];
  const converted = baseUsd * EXCHANGE_RATES[toCurrency];
  return converted;
}

export interface Account {
  id: number;
  name: string;
  native_currency: string;
  balance: number;
}

interface Props {
  account?: Account | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (acct: any) => void;
}

// The Component
export function EditAccountModal({ account, isOpen, onClose, onSave }: Props) {

  // 1. Persistent Account Context: Initialize entirely Native First
  const [currency, setCurrency] = useState('USD');
  const [balanceInput, setBalanceInput] = useState('');
  
  useEffect(() => {
    // When opening Modal, load Native Account Context 
    if (isOpen && account) {
      setCurrency(account.native_currency || 'USD');
      setBalanceInput(account.balance.toString());
    } else if (isOpen) {
      setCurrency('USD');
      setBalanceInput('');
    }
  }, [isOpen, account]);

  // 2. Prevent "Magnitude Drift" Bug
  const handleBalanceUpdate = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Crucial Step: Strip out comma formatting BEFORE saving to state and parsing.
    // This stops JS from breaking `211,000` into `211` 
    const rawValue = e.target.value.replace(/,/g, '');
    
    // Only accept numeric inputs (incl. decimals and negatives)
    if (/^-?\d*\.?\d*$/.test(rawValue)) {
      setBalanceInput(rawValue);
    }
  };

  // 3. Bidirectional logic: Recalculate upon Currency Select Shift
  const handleCurrencyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newCurrency = e.target.value;
    
    if (balanceInput) {
      // Must also strip commas when parsing to run conversions
      const currentVal = parseFloat(balanceInput.replace(/,/g, ''));
      
      if (!isNaN(currentVal)) {
        const recalculated = convertCurrency(currentVal, currency, newCurrency);
        
        // Clean up visual integer trailing numbers on new native balances
        const parsedNewStr = newCurrency === 'KRW' 
          ? Math.round(recalculated).toString() 
          : recalculated.toFixed(2);
          
        setBalanceInput(parsedNewStr);
      }
    }
    
    // Update Modal View Currency
    setCurrency(newCurrency);
  };

  const handleSave = () => {
    // Final scrub of characters on save
    const finalBalance = parseFloat(balanceInput.replace(/,/g, ''));
    if (isNaN(finalBalance)) return;

    // 4. Global View Layer Storage Separation 
    // Data Entry/Storage relies exclusively on the finalized native outputs.
    // You only execute 'USD Roll-Ups' outwardly in the Main Dashboard components.
    onSave({
      ...account,
      native_currency: currency,
      balance: finalBalance, 
    });
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal-content">
        <h2>{account ? 'Edit Account' : 'Add Account'}</h2>
        
        <div className="form-group">
          <label>Currency</label>
          <select value={currency} onChange={handleCurrencyChange}>
            <option value="USD">USD ($)</option>
            <option value="KRW">KRW (₩)</option>
            <option value="EUR">EUR (€)</option>
          </select>
        </div>

        <div className="form-group">
          <label>Balance</label>
          <input
            type="text"
            // Displays visually pleasant commas (e.g., 211,000)
            value={formatDisplayBalance(balanceInput, currency)}
            onChange={handleBalanceUpdate}
            // Auto swap placeholder based on floating structure
            placeholder={`0${currency !== 'KRW' ? '.00' : ''}`}
          />
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button onClick={handleSave}>Save Native Amount</button>
        </div>
      </div>
    </div>
  );
}
