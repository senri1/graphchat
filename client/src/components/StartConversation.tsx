import { FormEvent, useState } from 'react';

interface StartConversationProps {
  onStart: (message: string) => Promise<void> | void;
}

const StartConversation = ({ onStart }: StartConversationProps) => {
  const [value, setValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    try {
      setIsSubmitting(true);
      await onStart(trimmed);
      setValue('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex w-full max-w-xl flex-col gap-4 rounded-2xl border border-slate-700 bg-slate-900/60 p-6 text-left"
    >
      <div>
        <h2 className="text-lg font-semibold text-white">Start a new conversation</h2>
        <p className="mt-1 text-sm text-slate-400">
          Ask the assistant anything to create the root of your conversation tree.
        </p>
      </div>
      <textarea
        name="initial-message"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={5}
        placeholder="Describe what you need help with..."
        className="w-full resize-y rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
      />
      <button
        type="submit"
        disabled={isSubmitting || !value.trim()}
        className="inline-flex items-center justify-center rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-300"
      >
        {isSubmitting ? 'Starting…' : 'Start conversation'}
      </button>
    </form>
  );
};

export default StartConversation;
