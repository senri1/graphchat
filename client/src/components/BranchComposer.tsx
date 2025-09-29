import { FormEvent, useState } from 'react';

interface BranchComposerProps {
  disabled?: boolean;
  onSubmit: (value: string) => Promise<void> | void;
}

const BranchComposer = ({ disabled = false, onSubmit }: BranchComposerProps) => {
  const [value, setValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!value.trim() || disabled) {
      return;
    }
    try {
      setIsSubmitting(true);
      await onSubmit(value.trim());
      setValue('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-2xl border border-slate-700 bg-slate-900/60 p-4">
      <div>
        <label htmlFor="branch-message" className="text-sm font-medium text-slate-200">
          Continue or branch from the selected message
        </label>
        <p className="text-xs text-slate-400">
          Your follow-up will become a new branch and request a fresh assistant reply.
        </p>
      </div>
      <textarea
        id="branch-message"
        name="branch-message"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Type your message..."
        rows={4}
        className="w-full resize-y rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
      />
      <button
        type="submit"
        disabled={disabled || isSubmitting || !value.trim()}
        className="inline-flex items-center justify-center rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-300"
      >
        {isSubmitting ? 'Adding branch…' : 'Add branch'}
      </button>
    </form>
  );
};

export default BranchComposer;
