# Safety

Rules that never bend.

- Never start a cloud job, create a cloud resource or spend money without the owner's go-ahead. This covers every training launch, GPU scoring run, virtual machine start and bucket or dataset upload.
- Credentials are environment variables only. Never save one to a file, config or log. A credential pasted into a conversation is to be rotated, not used.
- Whoever writes or generates training data never opens the validation or test gold.
- A sealed Locker value that is stored never reaches the model: not in a prompt, a tool result or training data. A reveal in Chat is shown by the core on the card after the owner check, not by the model. The one secret the model may see is one the member typed into Chat ([keep-protect](../product/rulings/keep-protect.md)).
- Training data is English only and fully synthetic.
